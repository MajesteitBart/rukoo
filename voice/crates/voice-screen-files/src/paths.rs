//! Where the screen files of a meeting live. Relative paths use forward slashes on every
//! platform, as the journal and bucket sync store them.

use std::path::{Path, PathBuf};

/// The screen folder inside a meeting folder.
pub const SCREEN_DIR: &str = "screen";

/// `<meeting>/screen`.
pub fn screen_dir(meeting: &Path) -> PathBuf {
    let _ = meeting;
    todo!()
}

/// `<meeting>/screen/journal.jsonl`.
pub fn journal_path(meeting: &Path) -> PathBuf {
    let _ = meeting;
    todo!()
}

/// `<meeting>/screen/screen.json`.
pub fn screen_file_path(meeting: &Path) -> PathBuf {
    let _ = meeting;
    todo!()
}

/// The relative path of a video file: `screen/video/000001.mp4`.
pub fn video_file(seq: u64) -> String {
    let _ = seq;
    todo!()
}

/// A frame's id: `f-` and `at` as nine digits, `f-000412000`.
pub fn frame_id(at_ms: u64) -> String {
    let _ = at_ms;
    todo!()
}

/// The relative path of a frame's JPEG: `screen/frames/f-000412000.jpg`.
pub fn frame_file(id: &str) -> String {
    let _ = id;
    todo!()
}

/// `<meeting>/screen/clips/c-<start 9>-<end 9>-<seq 6>.mp4`: the requested range and the video
/// file it was cut from, so the same request gives the same name.
pub fn clip_path(meeting: &Path, start: u64, end: u64, seq: u64) -> PathBuf {
    let _ = (meeting, start, end, seq);
    todo!()
}

/// The media folders retention removes with `audio/`: video, frames, clips.
pub fn media_dirs(meeting: &Path) -> [PathBuf; 3] {
    let _ = meeting;
    todo!()
}
