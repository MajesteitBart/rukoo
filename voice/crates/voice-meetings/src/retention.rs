//! Removing meeting audio that the user doesn't want kept, as Ownkey does (`store.py:684-698`,
//! `service.py:1065-1098`).
//!
//! Only `audio/` goes; the transcript, the timeline and the meeting's events stay. Audio is
//! removed only after the meeting is `done`, counted from the moment it became done, so a
//! meeting that was cut off and never transcribed never loses its audio.
//!
//! Each meeting follows the retention it started with, kept in its `meeting.json` (Ownkey's
//! `create_meeting` stored it the same way), so a changed setting applies to new meetings only.

use std::fs;
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
    let mut removed = Vec::new();
    for dir in lib.dirs() {
        if !dir.has_audio() {
            continue;
        }
        let id = dir.id().as_str();
        let retention = dir.retention().unwrap_or_else(|| retention_of(id));
        if retention == Retention::Keep {
            continue;
        }
        // The event log says when Rukoo was told the meeting is done.
        let Ok(Some(state)) = log.latest(id, events::MEETING_STATE) else {
            continue;
        };
        if state.data["state"].as_str() != Some(MeetingState::Done.as_str()) {
            continue;
        }
        let expired = match retention {
            Retention::AfterTranscription => true,
            Retention::Days7 => now.saturating_sub(state.created_at) >= WEEK_MS,
            Retention::Keep => false,
        };
        // A file that is in use stays until the next sweep.
        if expired && fs::remove_dir_all(dir.audio_dir()).is_ok() {
            removed.push(id.to_owned());
        }
    }
    removed
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
}
