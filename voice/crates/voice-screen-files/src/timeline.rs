//! What the screen process needs from the recorder's `timeline.jsonl`: anchors for the clock,
//! pause and resume, suspend, crash and stop. Every other line reads as `Other`.

use std::io;
use std::path::Path;

use serde::Deserialize;

use crate::follow::Follower;

/// The recorder's journal inside a meeting folder.
pub const TIMELINE_FILE: &str = "timeline.jsonl";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TimelineLine {
    Session {
        t: u64,
        wall: u64,
        boot: Option<u64>,
        session: u64,
    },
    Heartbeat {
        t: u64,
        wall: u64,
        boot: Option<u64>,
    },
    Pause {
        t: u64,
    },
    Resume {
        t: u64,
    },
    Suspend {
        t: u64,
        until: u64,
    },
    Crash {
        t: u64,
        last_seen: u64,
    },
    Stop {
        t: u64,
        reason: String,
    },
    Other,
}

impl TimelineLine {
    /// The line's meeting time; `None` for `Other`.
    pub fn t(&self) -> Option<u64> {
        match self {
            TimelineLine::Session { t, .. }
            | TimelineLine::Heartbeat { t, .. }
            | TimelineLine::Pause { t }
            | TimelineLine::Resume { t }
            | TimelineLine::Suspend { t, .. }
            | TimelineLine::Crash { t, .. }
            | TimelineLine::Stop { t, .. } => Some(*t),
            TimelineLine::Other => None,
        }
    }
}

/// The recorder's lines as `voice/RECORDING.md` "The timeline" writes them, reduced to what the
/// screen process reads. Fields it doesn't name are ignored.
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Raw {
    Session {
        t: u64,
        wall: u64,
        #[serde(default)]
        boot: Option<u64>,
        session: u64,
    },
    Heartbeat {
        t: u64,
        wall: u64,
        #[serde(default)]
        boot: Option<u64>,
    },
    Pause {
        t: u64,
    },
    Resume {
        t: u64,
    },
    Suspend {
        t: u64,
        until: u64,
    },
    Crash {
        t: u64,
        last_seen: u64,
    },
    Stop {
        t: u64,
        reason: String,
    },
    #[serde(other)]
    Other,
}

impl From<Raw> for TimelineLine {
    fn from(raw: Raw) -> TimelineLine {
        match raw {
            Raw::Session {
                t,
                wall,
                boot,
                session,
            } => TimelineLine::Session {
                t,
                wall,
                boot,
                session,
            },
            Raw::Heartbeat { t, wall, boot } => TimelineLine::Heartbeat { t, wall, boot },
            Raw::Pause { t } => TimelineLine::Pause { t },
            Raw::Resume { t } => TimelineLine::Resume { t },
            Raw::Suspend { t, until } => TimelineLine::Suspend { t, until },
            Raw::Crash { t, last_seen } => TimelineLine::Crash { t, last_seen },
            Raw::Stop { t, reason } => TimelineLine::Stop { t, reason },
            Raw::Other => TimelineLine::Other,
        }
    }
}

/// Follows a growing `timeline.jsonl` with the recorder's reading rules: a last line without a
/// newline waits for the next poll, a line that doesn't parse is skipped.
#[derive(Debug)]
pub struct TimelineFollower {
    follower: Follower,
}

impl TimelineFollower {
    pub fn new(meeting: &Path) -> TimelineFollower {
        TimelineFollower {
            follower: Follower::new(meeting.join(TIMELINE_FILE)),
        }
    }

    /// The complete lines written since the last poll; a missing timeline reads as none yet.
    pub fn poll(&mut self) -> io::Result<Vec<TimelineLine>> {
        Ok(self
            .follower
            .poll::<Raw>()?
            .into_iter()
            .map(TimelineLine::from)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io::Write;

    use voice_recorder::timeline::{Line, TimelineWriter};

    use super::*;
    use crate::testdir::TestDir;

    #[test]
    fn follows_lines_the_recorder_writes() {
        let dir = TestDir::new("timeline-follow");
        let path = dir.path().join(TIMELINE_FILE);
        let mut follower = TimelineFollower::new(dir.path());
        assert_eq!(follower.poll().unwrap(), vec![]);

        let mut w = TimelineWriter::open(&path).unwrap();
        w.write(&Line::Session {
            t: 0,
            wall: 1_793_384_408_939,
            boot: Some(123_456_000_000),
            session: 1,
            pid: 14_152,
            resumed: false,
            version: 1,
            recorder: "0.1.0".into(),
        })
        .unwrap();
        w.write(&Line::Segment {
            t: 41,
            track: "mic".into(),
            seq: 1,
            file: "audio/mic/000001.wav".into(),
        })
        .unwrap();
        w.write(&Line::Heartbeat {
            t: 1_050,
            wall: 1_793_384_409_989,
            boot: Some(123_466_500_000),
            samples: BTreeMap::from([("mic".into(), 16_144)]),
        })
        .unwrap();
        assert_eq!(
            follower.poll().unwrap(),
            vec![
                TimelineLine::Session {
                    t: 0,
                    wall: 1_793_384_408_939,
                    boot: Some(123_456_000_000),
                    session: 1,
                },
                TimelineLine::Other,
                TimelineLine::Heartbeat {
                    t: 1_050,
                    wall: 1_793_384_409_989,
                    boot: Some(123_466_500_000),
                },
            ]
        );

        // Lines from a recorder that doesn't write `boot` read with `None`.
        w.write(&Line::Heartbeat {
            t: 2_050,
            wall: 1_793_384_410_989,
            boot: None,
            samples: BTreeMap::new(),
        })
        .unwrap();
        w.write(&Line::Pause { t: 2_100 }).unwrap();
        w.write(&Line::Resume { t: 3_100 }).unwrap();
        w.write(&Line::Suspend {
            t: 4_000,
            until: 64_000,
        })
        .unwrap();
        w.write(&Line::Mark {
            t: 64_100,
            id: "k-1".into(),
            label: None,
        })
        .unwrap();
        drop(w);
        assert_eq!(
            follower.poll().unwrap(),
            vec![
                TimelineLine::Heartbeat {
                    t: 2_050,
                    wall: 1_793_384_410_989,
                    boot: None,
                },
                TimelineLine::Pause { t: 2_100 },
                TimelineLine::Resume { t: 3_100 },
                TimelineLine::Suspend {
                    t: 4_000,
                    until: 64_000,
                },
                TimelineLine::Other,
            ]
        );

        // A recorder killed mid-write, then resumed: the torn line never reaches the follower,
        // and the resumed session's lines arrive whole.
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(br#"{"kind":"heartbeat","t":65"#).unwrap();
        drop(f);
        assert_eq!(follower.poll().unwrap(), vec![]);
        let mut w = TimelineWriter::open(&path).unwrap();
        w.write(&Line::Session {
            t: 70_000,
            wall: 1_793_384_478_939,
            boot: Some(124_156_000_000),
            session: 2,
            pid: 14_200,
            resumed: true,
            version: 1,
            recorder: "0.1.0".into(),
        })
        .unwrap();
        w.write(&Line::Crash {
            t: 70_000,
            last_seen: 64_100,
        })
        .unwrap();
        w.write(&Line::Stop {
            t: 71_000,
            wall: 1_793_384_479_939,
            reason: "user".into(),
        })
        .unwrap();
        assert_eq!(
            follower.poll().unwrap(),
            vec![
                TimelineLine::Session {
                    t: 70_000,
                    wall: 1_793_384_478_939,
                    boot: Some(124_156_000_000),
                    session: 2,
                },
                TimelineLine::Crash {
                    t: 70_000,
                    last_seen: 64_100,
                },
                TimelineLine::Stop {
                    t: 71_000,
                    reason: "user".into(),
                },
            ]
        );
        assert_eq!(follower.poll().unwrap(), vec![]);
        assert_eq!(TimelineLine::Other.t(), None);
        assert_eq!(TimelineLine::Pause { t: 5 }.t(), Some(5));
    }

    #[test]
    fn broken_lines_are_skipped() {
        let dir = TestDir::new("timeline-broken");
        std::fs::write(
            dir.path().join(TIMELINE_FILE),
            concat!(
                "not json\n",
                r#"{"kind":"session","t":0}"#,
                "\n",
                r#"{"kind":"pause","t":5}"#,
                "\n"
            ),
        )
        .unwrap();
        let mut follower = TimelineFollower::new(dir.path());
        assert_eq!(follower.poll().unwrap(), vec![TimelineLine::Pause { t: 5 }]);
    }
}
