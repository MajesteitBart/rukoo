//! Removing meeting audio that the user doesn't want kept, as Ownkey does (`store.py:684-698`,
//! `service.py:1065-1098`).
//!
//! Only `audio/` goes; the transcript, the timeline and the meeting's events stay. Audio is
//! removed only after the meeting is `done`, counted from the moment it became done, so a
//! meeting that was cut off and never transcribed never loses its audio.
//!
//! Each meeting follows the retention it started with, kept in its `meeting.json` (Ownkey's
//! `create_meeting` stored it the same way), so a changed setting applies to new meetings only.
//!
//! Bucket sync can hold a meeting's media past its time ([`retention_sweep_holding`]) until it
//! reached the bucket, and give it up part by part when the disk runs low ([`release_held`]).

use std::fs;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use voice_bridge::EventLog;
use voice_core::config::Retention;
use voice_protocol::{events, MeetingState};

use crate::library::Library;

/// Seven days, for [`Retention::Days7`].
pub const WEEK_MS: u64 = 7 * 86_400_000;

/// Removes the audio of every meeting whose retention has run out. A meeting's retention is the
/// one in its `meeting.json`; `retention_of` gives it by id for a meeting from before Voice
/// stored it there. Returns the meetings whose audio went.
///
/// Run it at start, after a meeting is done, and every minute or so.
pub fn retention_sweep(
    lib: &Library,
    log: &EventLog,
    retention_of: impl Fn(&str) -> Retention,
) -> Vec<String> {
    retention_sweep_at(lib, log, retention_of, now_ms())
}

/// [`retention_sweep`] at the wall time `now`, in ms.
pub fn retention_sweep_at(
    lib: &Library,
    log: &EventLog,
    retention_of: impl Fn(&str) -> Retention,
    now: u64,
) -> Vec<String> {
    retention_sweep_holding(lib, log, retention_of, |_| false, now).removed
}

/// What a sweep did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Swept {
    /// Meetings whose media went.
    pub removed: Vec<String>,
    /// Expired meetings that `hold` kept, oldest first, for the disk floor (voice/README.md,
    /// Storage).
    pub held: Vec<String>,
}

/// [`retention_sweep_at`] that leaves alone the meetings `hold` names: bucket sync holds media that
/// hasn't reached the bucket. `hold` is asked once per meeting, and only for a meeting whose
/// retention ran out, right before its media would go.
pub fn retention_sweep_holding(
    lib: &Library,
    log: &EventLog,
    retention_of: impl Fn(&str) -> Retention,
    hold: impl Fn(&str) -> bool,
    now: u64,
) -> Swept {
    let mut swept = Swept::default();
    // Meeting ids sort by their start, so the held list comes out oldest first.
    for dir in lib.dirs() {
        if !dir.has_audio() {
            continue;
        }
        let id = dir.id().as_str();
        if !expired(&dir, log, &retention_of, now) {
            continue;
        }
        if hold(id) {
            swept.held.push(id.to_owned());
            continue;
        }
        // A file that is in use stays until the next sweep.
        if fs::remove_dir_all(dir.audio_dir()).is_ok() {
            swept.removed.push(id.to_owned());
        }
    }
    swept
}

/// Whether the meeting's retention ran out: it is `done` and its time since then is up.
fn expired(
    dir: &crate::MeetingDir,
    log: &EventLog,
    retention_of: &impl Fn(&str) -> Retention,
    now: u64,
) -> bool {
    let id = dir.id().as_str();
    let retention = dir.retention().unwrap_or_else(|| retention_of(id));
    if retention == Retention::Keep {
        return false;
    }
    // The event log says when Rukoo was told the meeting is done.
    let Ok(Some(state)) = log.latest(id, events::MEETING_STATE) else {
        return false;
    };
    if state.data["state"].as_str() != Some(MeetingState::Done.as_str()) {
        return false;
    }
    match retention {
        Retention::AfterTranscription => true,
        Retention::Days7 => now.saturating_sub(state.created_at) >= WEEK_MS,
        Retention::Keep => false,
    }
}

/// One media folder of a meeting, in the order held media gives way when the disk runs low.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MediaPart {
    /// `screen/video`.
    Video,
    /// `screen/frames`.
    Frames,
    /// `audio/`.
    Audio,
}

impl MediaPart {
    /// Video first, then frames, then audio.
    pub const ORDER: [MediaPart; 3] = [MediaPart::Video, MediaPart::Frames, MediaPart::Audio];

    /// The kinds of bucket sync's queue rows this part holds.
    pub fn kind(self) -> &'static str {
        match self {
            MediaPart::Video => "video",
            MediaPart::Frames => "frame",
            MediaPart::Audio => "audio",
        }
    }

    /// The part's folder in a meeting folder.
    pub fn folder(self, meeting: &Path) -> std::path::PathBuf {
        match self {
            MediaPart::Video => meeting.join("screen").join("video"),
            MediaPart::Frames => meeting.join("screen").join("frames"),
            MediaPart::Audio => meeting.join("audio"),
        }
    }

    /// The part's files that bucket sync would upload, relative to the meeting folder with forward
    /// slashes as sync names them, sorted. `*.tmp` and `*.restore` files never upload, so they
    /// aren't listed.
    pub fn files(self, meeting: &Path) -> Vec<String> {
        let mut files = Vec::new();
        collect_files(meeting, &self.folder(meeting), &mut files);
        files.sort();
        files
    }
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => collect_files(root, &path, out),
            Ok(_) => {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.ends_with(".tmp") || name.ends_with(".restore") {
                    continue;
                }
                if let Ok(relative) = path.strip_prefix(root) {
                    let parts: Vec<String> = relative
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy().into_owned())
                        .collect();
                    out.push(parts.join("/"));
                }
            }
            Err(_) => {}
        }
    }
}

/// Removes one media folder of one meeting and returns the bytes it freed. A part the meeting
/// doesn't have frees nothing: before screen recording, `Video` and `Frames` never do.
pub fn release_held(lib: &Library, id: &str, part: MediaPart) -> io::Result<u64> {
    let dir = lib
        .dir(id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no meeting with that id"))?;
    let folder = part.folder(dir.path());
    if !folder.is_dir() {
        return Ok(0);
    }
    let bytes = folder_bytes(&folder);
    fs::remove_dir_all(&folder)?;
    Ok(bytes)
}

fn folder_bytes(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => folder_bytes(&entry.path()),
            Ok(_) => entry.metadata().map_or(0, |m| m.len()),
            Err(_) => 0,
        })
        .sum()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::CreateMeeting;
    use crate::test_support::TempDir;
    use serde_json::json;
    use voice_protocol::{ScreenMode, StartedBy, Track};

    fn meeting(lib: &Library, log: &EventLog, states: &[&str]) -> String {
        let dir = lib
            .create(&CreateMeeting {
                title: String::new(),
                tracks: vec![Track::Mic],
                sources: Default::default(),
                screen: ScreenMode::Off,
                started_by: StartedBy::Voice,
                context: None,
            })
            .unwrap();
        fs::create_dir_all(dir.audio_dir().join("mic")).unwrap();
        fs::write(dir.audio_dir().join("mic").join("000001.wav"), b"RIFF").unwrap();
        let id = dir.id().to_string();
        for state in states {
            let data = match *state {
                "recording" => json!({"state":"recording","at":0}),
                "processing" => json!({"state":"processing","at":10,"endedAt":1,"reason":"user"}),
                "failed" => json!({"state":"failed","at":10,"endedAt":1,"reason":"offline"}),
                _ => json!({"state": state, "at":10, "endedAt":1}),
            };
            log.append("meeting.state", Some(&id), data).unwrap();
        }
        id
    }

    #[test]
    fn audio_goes_only_after_the_meeting_is_done_and_its_time_is_up() {
        let tmp = TempDir::new("retention");
        let lib = Library::open(tmp.path()).unwrap();
        let log = EventLog::open(tmp.path()).unwrap();
        let after = meeting(&lib, &log, &["recording", "processing", "done"]);
        let week = meeting(&lib, &log, &["recording", "processing", "done"]);
        let keep = meeting(&lib, &log, &["recording", "processing", "done"]);
        let interrupted = meeting(&lib, &log, &["recording"]);
        let processing = meeting(&lib, &log, &["recording", "processing"]);
        let failed = meeting(&lib, &log, &["recording", "processing", "failed"]);
        let retried = meeting(&lib, &log, &["recording", "processing", "failed", "done"]);
        let setting = |id: &str| {
            if id == after || id == retried {
                Retention::AfterTranscription
            } else if id == keep {
                Retention::Keep
            } else {
                Retention::Days7
            }
        };
        let has_audio = |id: &str| lib.dir(id).unwrap().has_audio();
        let done_at = log
            .latest(&week, events::MEETING_STATE)
            .unwrap()
            .unwrap()
            .created_at;

        let mut removed = retention_sweep_at(&lib, &log, setting, done_at + 1000);
        removed.sort();
        let mut expected = vec![after.clone(), retried.clone()];
        expected.sort();
        assert_eq!(removed, expected);
        assert!(!has_audio(&after));
        assert!(has_audio(&week), "a week hasn't passed");

        let removed = retention_sweep_at(&lib, &log, setting, done_at + WEEK_MS);
        assert_eq!(removed, vec![week.clone()]);
        // Ten years on: kept meetings and meetings that never got done still have their audio.
        let removed = retention_sweep_at(&lib, &log, setting, done_at + 520 * WEEK_MS);
        assert!(removed.is_empty(), "{removed:?}");
        for id in [&keep, &interrupted, &processing, &failed] {
            assert!(has_audio(id), "{id}");
        }
        // The text stays.
        assert!(lib
            .dir(&week)
            .unwrap()
            .path()
            .join("meeting.json")
            .is_file());
    }

    #[test]
    fn each_meeting_keeps_the_retention_it_started_with() {
        let tmp = TempDir::new("retention-stamped");
        let lib = Library::open(tmp.path()).unwrap();
        let log = EventLog::open(tmp.path()).unwrap();
        let states = ["recording", "processing", "done"];
        // Recorded before Voice stored the retention: it follows the setting.
        let older = meeting(&lib, &log, &states);
        lib.set_retention(Retention::Keep);
        let kept = meeting(&lib, &log, &states);
        lib.set_retention(Retention::Days7);
        let week = meeting(&lib, &log, &states);
        assert_eq!(lib.dir(&older).unwrap().retention(), None);
        assert_eq!(lib.dir(&kept).unwrap().retention(), Some(Retention::Keep));
        assert_eq!(lib.dir(&week).unwrap().retention(), Some(Retention::Days7));
        let raw: serde_json::Value = serde_json::from_slice(
            &fs::read(lib.dir(&kept).unwrap().path().join("meeting.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(raw["retention"], "keep");
        assert!(lib.dir(&kept).unwrap().meeting().is_ok());

        let has_audio = |id: &str| lib.dir(id).unwrap().has_audio();
        let done_at = log
            .latest(&week, events::MEETING_STATE)
            .unwrap()
            .unwrap()
            .created_at;
        // The user now picks "Remove after transcription": only the meeting without its own
        // choice follows it.
        let now = |ms| retention_sweep_at(&lib, &log, |_| Retention::AfterTranscription, ms);
        assert_eq!(now(done_at + 1000), vec![older]);
        assert!(has_audio(&kept) && has_audio(&week));
        assert_eq!(now(done_at + WEEK_MS), vec![week]);
        assert!(now(done_at + 520 * WEEK_MS).is_empty());
        assert!(has_audio(&kept), "kept until the user deletes the meeting");
    }

    /// Stand-in screen media next to the audio, as RUK-108 lays it out.
    fn add_screen_media(lib: &Library, id: &str) {
        let dir = lib.dir(id).unwrap();
        let screen = dir.path().join("screen");
        fs::create_dir_all(screen.join("video")).unwrap();
        fs::create_dir_all(screen.join("frames")).unwrap();
        fs::write(screen.join("video").join("000001.mp4"), vec![1u8; 300]).unwrap();
        fs::write(screen.join("frames").join("f-000001000.jpg"), vec![2u8; 70]).unwrap();
        fs::write(screen.join("journal.jsonl"), b"{}\n").unwrap();
    }

    #[test]
    fn a_held_meeting_keeps_its_media_past_its_time() {
        let tmp = TempDir::new("retention-held");
        let lib = Library::open(tmp.path()).unwrap();
        let log = EventLog::open(tmp.path()).unwrap();
        let states = ["recording", "processing", "done"];
        let older = meeting(&lib, &log, &states);
        let held = meeting(&lib, &log, &states);
        let free = meeting(&lib, &log, &states);
        let unfinished = meeting(&lib, &log, &["recording", "processing"]);
        for id in [&older, &held, &free] {
            add_screen_media(&lib, id);
        }
        let asked = std::cell::RefCell::new(Vec::new());
        let hold = |id: &str| {
            asked.borrow_mut().push(id.to_string());
            id == older || id == held
        };
        // The newest of them became done last.
        let done_at = log
            .latest(&free, events::MEETING_STATE)
            .unwrap()
            .unwrap()
            .created_at;

        // A week hasn't passed: nobody is asked, nothing goes.
        let swept = retention_sweep_holding(&lib, &log, |_| Retention::Days7, hold, done_at + 1);
        assert_eq!(swept, Swept::default());
        assert!(asked.borrow().is_empty(), "{:?}", asked.borrow());

        let swept =
            retention_sweep_holding(&lib, &log, |_| Retention::Days7, hold, done_at + WEEK_MS);
        assert_eq!(swept.removed, vec![free.clone()]);
        // Oldest first: ids sort by their start, to the second.
        let mut oldest_first = vec![older.clone(), held.clone()];
        oldest_first.sort();
        assert_eq!(swept.held, oldest_first);
        // Only meetings whose time is up are asked, each once.
        let mut expected = vec![older.clone(), held.clone(), free.clone()];
        expected.sort();
        assert_eq!(*asked.borrow(), expected);
        for id in [&older, &held] {
            let dir = lib.dir(id).unwrap();
            assert!(dir.has_audio(), "{id} keeps its audio");
            assert!(dir.path().join("screen/video/000001.mp4").is_file());
            assert!(dir.path().join("screen/frames/f-000001000.jpg").is_file());
        }
        assert!(!lib.dir(&free).unwrap().has_audio());
        assert!(lib.dir(&unfinished).unwrap().has_audio());

        // Without a hold, the plain sweep removes what was held.
        let removed = retention_sweep_at(&lib, &log, |_| Retention::Days7, done_at + WEEK_MS);
        assert_eq!(removed, oldest_first);
    }

    #[test]
    fn release_held_removes_one_part_at_a_time() {
        let tmp = TempDir::new("retention-release");
        let lib = Library::open(tmp.path()).unwrap();
        let log = EventLog::open(tmp.path()).unwrap();
        let id = meeting(&lib, &log, &["recording", "processing", "done"]);
        add_screen_media(&lib, &id);
        let path = lib.dir(&id).unwrap().path().to_path_buf();
        // Each part lists its files as bucket sync names them; files that never upload don't
        // count.
        fs::write(path.join("audio/mic/000002.wav.restore"), b"RI").unwrap();
        fs::write(path.join("screen/video/000002.mp4.tmp"), b"ft").unwrap();
        assert_eq!(
            MediaPart::ORDER.map(|part| part.files(&path)),
            [
                vec!["screen/video/000001.mp4".to_string()],
                vec!["screen/frames/f-000001000.jpg".to_string()],
                vec!["audio/mic/000001.wav".to_string()],
            ]
        );
        fs::remove_file(path.join("audio/mic/000002.wav.restore")).unwrap();
        fs::remove_file(path.join("screen/video/000002.mp4.tmp")).unwrap();

        assert_eq!(release_held(&lib, &id, MediaPart::Video).unwrap(), 300);
        assert!(!path.join("screen/video").exists());
        assert!(path.join("screen/frames/f-000001000.jpg").is_file());
        assert!(path.join("audio/mic/000001.wav").is_file());
        // A part that is gone already frees nothing.
        assert_eq!(release_held(&lib, &id, MediaPart::Video).unwrap(), 0);

        assert_eq!(release_held(&lib, &id, MediaPart::Frames).unwrap(), 70);
        assert!(path.join("audio/mic/000001.wav").is_file());
        assert_eq!(release_held(&lib, &id, MediaPart::Audio).unwrap(), 4);
        assert!(!path.join("audio").exists());
        // The text stays, the journal included.
        assert!(path.join("meeting.json").is_file());
        assert!(path.join("screen/journal.jsonl").is_file());
        assert_eq!(
            release_held(&lib, "m-20000101-000000-0000", MediaPart::Audio)
                .unwrap_err()
                .kind(),
            io::ErrorKind::NotFound
        );
        assert_eq!(
            MediaPart::ORDER.map(MediaPart::kind),
            ["video", "frame", "audio"]
        );
    }
}
