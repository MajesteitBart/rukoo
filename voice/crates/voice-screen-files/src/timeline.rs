//! What the screen process needs from the recorder's `timeline.jsonl`: anchors for the clock,
//! pause and resume, suspend, crash and stop. Every other line reads as `Other`.

use std::io;
use std::path::{Path, PathBuf};

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

/// Follows a growing `timeline.jsonl` with the recorder's reading rules: a last line without a
/// newline waits for the next poll, a line that doesn't parse is skipped.
#[derive(Debug)]
pub struct TimelineFollower {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
}

impl TimelineFollower {
    pub fn new(meeting: &Path) -> TimelineFollower {
        let _ = meeting;
        todo!()
    }

    pub fn poll(&mut self) -> io::Result<Vec<TimelineLine>> {
        let _ = (&self.path, self.offset, &self.partial);
        todo!()
    }
}
