//! `screen/journal.jsonl`: the screen process's append-only journal. It is its only writer.
//!
//! One JSON object per line, written with a single write and a trailing newline, `kind` first.
//! A reader ignores a last line without a newline and any line that doesn't parse, as for
//! `timeline.jsonl`. `t` is meeting time in ms on the recorder's clock.

use std::collections::BTreeSet;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The version of the screen folder format, in `session` lines.
pub const FORMAT_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Line {
    /// The process starts recording into the meeting. `mode` is `frames` or `video`; `anchor`
    /// is `boot` or `wall`, the clock the mapping uses; `screen` is the crate version.
    Session {
        t: u64,
        wall: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        boot: Option<u64>,
        session: u64,
        pid: u32,
        resumed: bool,
        version: u32,
        mode: String,
        anchor: String,
        screen: String,
    },
    /// Capture moves to a monitor. `reason`: `start`, `resume`, `user`, `lost`.
    Monitor {
        t: u64,
        id: String,
        name: String,
        width: u32,
        height: u32,
        primary: bool,
        reason: String,
    },
    /// The first frame of a capture session arrived (start, switch, unlock, resume).
    Capture {
        t: u64,
        wall: u64,
        monitor: String,
        width: u32,
        height: u32,
    },
    /// A video file starts; its media time 0 is meeting time `t`.
    Video {
        t: u64,
        seq: u64,
        file: String,
        width: u32,
        height: u32,
        fps: u32,
        encoder: String,
        hardware: bool,
    },
    /// A video file ended; `t` is its last sample's end. `reason`: `pause`, `lock`, `monitor`,
    /// `resize`, `clock`, `stop`, `error`, `disk`, `crash`.
    VideoEnd {
        t: u64,
        seq: u64,
        reason: String,
        bytes: u64,
    },
    /// A frame was saved and read; written after OCR. `ocr`: `ok`, `none`, `skipped`, `failed`.
    Frame {
        t: u64,
        id: String,
        file: String,
        width: u32,
        height: u32,
        text: String,
        ocr: String,
        language: Option<String>,
    },
    /// A part stopped for the rest of the meeting. `what`: `video`, `frames`; `reason`:
    /// `disk`, `encoder`, `device`.
    Dropped {
        t: u64,
        what: String,
        reason: String,
    },
    /// The D3D device was removed or reset; the next `capture` ends the gap.
    DeviceLost { t: u64 },
    /// The session locked or disconnected.
    Lock { t: u64 },
    /// The session came back.
    Unlock { t: u64 },
    /// Every 2 s.
    Heartbeat {
        t: u64,
        wall: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        boot: Option<u64>,
        frames: u64,
        video_bytes: u64,
    },
    /// Written by a resumed session: the dead one was last seen at `last_seen`.
    Crash { t: u64, last_seen: u64 },
    /// Nothing follows. `reason`: `meeting`, `dropped`, `failed`, `interrupted`.
    Stop { t: u64, reason: String },
    /// A kind this version doesn't know.
    #[serde(other)]
    Unknown,
}

impl Line {
    /// The line's meeting time, or `None` for an unknown kind.
    pub fn t(&self) -> Option<u64> {
        todo!()
    }
}

/// The journal's one writer.
#[derive(Debug)]
pub struct JournalWriter {
    file: File,
}

impl JournalWriter {
    /// Exclusive writer: on Windows share READ | DELETE only; cuts a last line without a newline.
    /// `Busy` when another writer holds it.
    pub fn open(meeting: &Path) -> Result<JournalWriter, OpenError> {
        let _ = meeting;
        todo!()
    }

    /// One write, with a trailing newline.
    pub fn write(&mut self, line: &Line) -> io::Result<()> {
        let _ = (&self.file, line);
        todo!()
    }

    pub fn sync(&mut self) {
        todo!()
    }
}

#[derive(Debug)]
pub enum OpenError {
    /// Another screen process writes this journal.
    Busy,
    Io(io::Error),
}

/// Follows a growing journal: each `poll` returns the complete lines written since the last.
#[derive(Debug)]
pub struct JournalReader {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
}

impl JournalReader {
    pub fn new(meeting: &Path) -> JournalReader {
        let _ = meeting;
        todo!()
    }

    pub fn poll(&mut self) -> io::Result<Vec<Line>> {
        let _ = (&self.path, self.offset, &self.partial);
        todo!()
    }
}

/// Every complete line of the journal. A missing journal reads as no lines.
pub fn read_all(meeting: &Path) -> io::Result<Vec<Line>> {
    let _ = meeting;
    todo!()
}

/// What a journal says about the sessions that wrote it, for `--resume`, `finalize` and the
/// supervisor.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct History {
    pub sessions: u64,
    /// The highest `t` of any line.
    pub last_seen: u64,
    pub last_video_seq: u64,
    /// The video file without a `video_end`: seq, relative file.
    pub open_video: Option<(u64, String)>,
    /// The reason of a `dropped` line for each part.
    pub dropped_video: Option<String>,
    pub dropped_frames: Option<String>,
    /// The reason of the `stop` line.
    pub stopped: Option<String>,
    /// The `mode` of the last `session` line.
    pub mode: Option<String>,
    /// The `t` of a `lock` without an `unlock` after it.
    pub locked_since: Option<u64>,
    /// The relative files of every `frame` line.
    pub journaled_frames: BTreeSet<String>,
}

impl History {
    pub fn from_lines(lines: &[Line]) -> History {
        let _ = lines;
        todo!()
    }
}
