//! Which part of the screen recording stops when the disk fills, the encoder fails or the
//! graphics device is lost, and the free-space rule every other writer follows.
//!
//! Video stops below `VIDEO_MIN_FREE` free on the meeting folder's volume, frames below
//! `FRAMES_MIN_FREE`; video always goes first, and a drop lasts for the rest of the meeting.
//! The audio is never dropped.

use crate::journal::History;

pub const VIDEO_MIN_FREE: u64 = 4 << 30;
pub const FRAMES_MIN_FREE: u64 = 2 << 30;
pub const DISK_CHECK_MS: u64 = 5_000;
pub const ENCODER_RETRY_MS: u64 = 2_000;
pub const DEVICE_RETRIES: u32 = 2;
/// What another writer leaves free on top of the screen recording's floor.
pub const RESERVE_MARGIN: u64 = 2 << 30;

/// Whether another writer may put `bytes` on the meetings volume now: what stays free must
/// cover the floor of the screen recording that could be running (`VIDEO_MIN_FREE` while a
/// meeting records, else `FRAMES_MIN_FREE`) plus `RESERVE_MARGIN`.
pub fn reserve_ok(free: u64, bytes: u64, meeting_live: bool) -> bool {
    let _ = (free, bytes, meeting_live);
    todo!()
}

/// A part of the screen recording.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Part {
    Video,
    Frames,
}

impl Part {
    /// The journal's `what`: `video` or `frames`.
    pub fn as_str(self) -> &'static str {
        match self {
            Part::Video => "video",
            Part::Frames => "frames",
        }
    }

    pub fn parse(what: &str) -> Option<Part> {
        match what {
            "video" => Some(Part::Video),
            "frames" => Some(Part::Frames),
            _ => None,
        }
    }
}

/// Why a part was dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Reason {
    Disk,
    Encoder,
    Device,
}

impl Reason {
    /// The journal's `reason` and the mark's `detail`: `disk`, `encoder` or `device`.
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Disk => "disk",
            Reason::Encoder => "encoder",
            Reason::Device => "device",
        }
    }

    pub fn parse(reason: &str) -> Option<Reason> {
        match reason {
            "disk" => Some(Reason::Disk),
            "encoder" => Some(Reason::Encoder),
            "device" => Some(Reason::Device),
            _ => None,
        }
    }
}

/// What has been dropped so far. Each `on_*` returns the drops it newly decided, video first;
/// the caller journals them in that order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DropState {
    pub video: Option<Reason>,
    pub frames: Option<Reason>,
    encoder_failures: u32,
    device_failures: u32,
    video_on: bool,
}

/// What to do after an encoder error or a device loss.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncoderStep {
    /// Try again with a new device and a new file.
    Retry,
    Drop(Part, Reason),
    /// Nothing to do: the part is dropped already or was never on.
    Ignore,
}

impl DropState {
    /// Frames-only meetings: `video` stays `None`, but video counts as not recording.
    pub fn new(video_on: bool) -> DropState {
        let _ = video_on;
        todo!()
    }

    /// The drops a resumed session inherits from the journal.
    pub fn from_history(h: &History, video_on: bool) -> DropState {
        let _ = (h, video_on);
        todo!()
    }

    pub fn on_free_bytes(&mut self, free: u64) -> Vec<(Part, Reason)> {
        let _ = (
            free,
            self.encoder_failures,
            self.device_failures,
            self.video_on,
        );
        todo!()
    }

    /// A write failed with a full disk.
    pub fn on_disk_full(&mut self, part: Part) -> Vec<(Part, Reason)> {
        let _ = part;
        todo!()
    }

    /// First: `Retry`; second: `Drop(Video, Encoder)`.
    pub fn on_encoder_error(&mut self) -> EncoderStep {
        todo!()
    }

    /// `Retry` until `DEVICE_RETRIES` recreations failed, then `Drop(Video, Device)`,
    /// `Drop(Frames, Device)`.
    pub fn on_device_lost(&mut self) -> EncoderStep {
        todo!()
    }

    pub fn all_dropped(&self) -> bool {
        todo!()
    }
}
