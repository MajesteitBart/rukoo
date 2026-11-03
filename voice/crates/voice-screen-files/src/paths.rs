//! Where the screen files of a meeting live. Relative paths use forward slashes on every
//! platform, as the journal and bucket sync store them.

use std::path::{Path, PathBuf};

/// The screen folder inside a meeting folder.
pub const SCREEN_DIR: &str = "screen";
/// The journal's name inside the screen folder.
pub const JOURNAL_FILE: &str = "journal.jsonl";
/// The live screen process's file inside the screen folder.
pub const SCREEN_FILE: &str = "screen.json";
/// The media folders inside the screen folder.
pub const VIDEO_DIR: &str = "video";
pub const FRAMES_DIR: &str = "frames";
pub const CLIPS_DIR: &str = "clips";

/// `<meeting>/screen`.
pub fn screen_dir(meeting: &Path) -> PathBuf {
    meeting.join(SCREEN_DIR)
}

/// `<meeting>/screen/journal.jsonl`.
pub fn journal_path(meeting: &Path) -> PathBuf {
    screen_dir(meeting).join(JOURNAL_FILE)
}

/// `<meeting>/screen/screen.json`.
pub fn screen_file_path(meeting: &Path) -> PathBuf {
    screen_dir(meeting).join(SCREEN_FILE)
}

/// `<meeting>/screen/clips`.
pub fn clips_dir(meeting: &Path) -> PathBuf {
    screen_dir(meeting).join(CLIPS_DIR)
}

/// The relative path of a video file: `screen/video/000001.mp4`.
pub fn video_file(seq: u64) -> String {
    format!("{SCREEN_DIR}/{VIDEO_DIR}/{seq:06}.mp4")
}

/// A frame's id: `f-` and `at` as nine digits, `f-000412000`.
pub fn frame_id(at_ms: u64) -> String {
    format!("f-{at_ms:09}")
}

/// The relative path of a frame's JPEG: `screen/frames/f-000412000.jpg`.
pub fn frame_file(id: &str) -> String {
    format!("{SCREEN_DIR}/{FRAMES_DIR}/{id}.jpg")
}

/// The meeting time in a frame file's name, `screen/frames/f-000412000.jpg` or just
/// `f-000412000.jpg`, for JPEGs a crash left without a `frame` line.
pub fn frame_at(file: &str) -> Option<u64> {
    let name = file.rsplit('/').next()?;
    let digits = name.strip_prefix("f-")?.strip_suffix(".jpg")?;
    if digits.len() < 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// The file name of a clip: `c-<start 9>-<end 9>-<seq 6>.mp4`.
pub fn clip_name(start: u64, end: u64, seq: u64) -> String {
    format!("c-{start:09}-{end:09}-{seq:06}.mp4")
}

/// `<meeting>/screen/clips/c-<start 9>-<end 9>-<seq 6>.mp4`: the requested range and the video
/// file it was cut from, so the same request gives the same name.
pub fn clip_path(meeting: &Path, start: u64, end: u64, seq: u64) -> PathBuf {
    clips_dir(meeting).join(clip_name(start, end, seq))
}

/// The media folders retention removes with `audio/`: video, frames, clips.
pub fn media_dirs(meeting: &Path) -> [PathBuf; 3] {
    let screen = screen_dir(meeting);
    [
        screen.join(VIDEO_DIR),
        screen.join(FRAMES_DIR),
        screen.join(CLIPS_DIR),
    ]
}

/// The full path of a relative path from the journal, such as `screen/frames/f-000412000.jpg`.
/// `None` unless it is a plain path inside `screen/`: no `..`, no backslash, no drive or root,
/// so a damaged journal can't point a reader at another file.
pub fn resolve(meeting: &Path, relative: &str) -> Option<PathBuf> {
    let mut parts = relative.split('/');
    if parts.next() != Some(SCREEN_DIR) {
        return None;
    }
    let mut path = screen_dir(meeting);
    let mut any = false;
    for part in parts {
        let plain =
            !part.is_empty() && part != "." && part != ".." && !part.contains(['\\', ':', '\0']);
        if !plain {
            return None;
        }
        path.push(part);
        any = true;
    }
    any.then_some(path)
}

/// The full path of a video file the journal names, `None` unless it has the shape
/// [`video_file`] gives: `screen/video/`, six or more digits, `.mp4`. `finalize` truncates the
/// file it gets here, so a damaged journal can't make it cut the audio or the journal.
pub fn video_path(meeting: &Path, relative: &str) -> Option<PathBuf> {
    let digits = relative
        .strip_prefix(&format!("{SCREEN_DIR}/{VIDEO_DIR}/"))?
        .strip_suffix(".mp4")?;
    if digits.len() < 6 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    resolve(meeting, relative)
}

/// The full path of a frame's JPEG the journal names, `None` unless it has the shape
/// [`frame_file`] gives: `screen/frames/f-`, nine or more digits, `.jpg`. `frame.get` sends what
/// it reads here to Rukoo, so a damaged journal can't make it send `screen.json` and its token.
pub fn frame_path(meeting: &Path, relative: &str) -> Option<PathBuf> {
    let name = relative.strip_prefix(&format!("{SCREEN_DIR}/{FRAMES_DIR}/"))?;
    if name.contains('/') {
        return None;
    }
    frame_at(name)?;
    resolve(meeting, relative)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_have_their_documented_shape() {
        let m = Path::new("meetings").join("m-20261030-171203-4f2a");
        assert_eq!(video_file(1), "screen/video/000001.mp4");
        assert_eq!(video_file(1_234_567), "screen/video/1234567.mp4");
        assert_eq!(frame_id(412_000), "f-000412000");
        assert_eq!(frame_file("f-000412000"), "screen/frames/f-000412000.jpg");
        assert_eq!(
            clip_path(&m, 60_000, 75_000, 1),
            m.join("screen")
                .join("clips")
                .join("c-000060000-000075000-000001.mp4")
        );
        assert_eq!(journal_path(&m), m.join("screen").join("journal.jsonl"));
        assert_eq!(screen_file_path(&m), m.join("screen").join("screen.json"));
        assert_eq!(
            media_dirs(&m),
            [
                m.join("screen").join("video"),
                m.join("screen").join("frames"),
                m.join("screen").join("clips"),
            ]
        );
    }

    #[test]
    fn frame_names_give_back_their_time() {
        assert_eq!(frame_at("screen/frames/f-000412000.jpg"), Some(412_000));
        assert_eq!(frame_at("f-000000000.jpg"), Some(0));
        assert_eq!(
            frame_at(&frame_file(&frame_id(1_000_000_123))),
            Some(1_000_000_123)
        );
        assert_eq!(frame_at("f-000412000.jpg.tmp"), None);
        assert_eq!(frame_at("f-12.jpg"), None);
        assert_eq!(frame_at("g-000412000.jpg"), None);
        assert_eq!(frame_at("f-00041200x.jpg"), None);
    }

    #[test]
    fn resolve_keeps_readers_inside_the_screen_folder() {
        let m = Path::new("m");
        assert_eq!(
            resolve(m, "screen/frames/f-000412000.jpg"),
            Some(m.join("screen").join("frames").join("f-000412000.jpg"))
        );
        for bad in [
            "",
            "screen",
            "screen/",
            "audio/mic/000001.wav",
            "screen/../timeline.jsonl",
            "screen/frames/../../x",
            "screen//x",
            "screen/./x",
            "screen\\frames\\f.jpg",
            "screen/C:/x",
            "/screen/x",
        ] {
            assert_eq!(resolve(m, bad), None, "{bad:?}");
        }
    }

    #[test]
    fn media_paths_take_only_their_own_shape() {
        let m = Path::new("m");
        assert_eq!(
            video_path(m, &video_file(1)),
            Some(m.join("screen").join("video").join("000001.mp4"))
        );
        assert!(video_path(m, &video_file(1_234_567)).is_some());
        assert_eq!(
            frame_path(m, &frame_file(&frame_id(412_000))),
            Some(m.join("screen").join("frames").join("f-000412000.jpg"))
        );
        for bad in [
            "audio/mic/000001.wav",
            "screen/journal.jsonl",
            "screen/screen.json",
            "screen/video/1.mp4",
            "screen/video/00000x.mp4",
            "screen/video/000001.mp4.tmp",
            "screen/video/../../audio/mic/000001.mp4",
            "screen/frames/f-000412000.jpg",
            "screen/clips/c-000000000-000001000-000001.mp4",
            "/screen/video/000001.mp4",
        ] {
            assert_eq!(video_path(m, bad), None, "{bad:?}");
        }
        for bad in [
            "screen/screen.json",
            "screen/journal.jsonl",
            "screen/frames/f-12.jpg",
            "screen/frames/sub/f-000412000.jpg",
            "screen/frames/f-000412000.jpg.tmp",
            "screen/frames/../screen.json",
            "screen/video/000001.mp4",
            "audio/mic/f-000412000.jpg",
        ] {
            assert_eq!(frame_path(m, bad), None, "{bad:?}");
        }
    }
}
