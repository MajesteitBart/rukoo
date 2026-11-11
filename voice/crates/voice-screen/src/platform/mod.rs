//! What the screen process needs from the computer it records, as traits with plain Rust types.
//!
//! The orchestration in `record` never names a graphics API, an encoder or an operating system:
//! it captures frames, encodes video, reads text and asks for free space through these traits.
//! `platform/windows.rs` implements them with Direct3D, Media Foundation and WinRT; a macOS
//! backend implements the same ones with ScreenCaptureKit, VideoToolbox and Vision.

use std::fmt;
use std::path::Path;

use voice_screen_files::monitors::MonitorInfo;

#[cfg(windows)]
pub mod windows;

/// A captured frame: the platform's own picture, and what it says about it. `width` and `height`
/// are even (an odd last column or row is cropped). `boot` is when it was composed, in interrupt
/// time. `dirty` is the fraction of the screen its dirty regions cover, where the platform
/// reports them. `generation` names the capture session, so frames of a stopped one are dropped.
#[derive(Clone)]
pub struct Frame<F> {
    pub picture: F,
    pub boot: u64,
    pub width: u32,
    pub height: u32,
    pub dirty: Option<f32>,
    pub generation: u64,
}

/// Why a platform call failed, in the terms the orchestration decides by: whether the graphics
/// device went, and what to write in the log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlatformError {
    /// The graphics device was removed, reset or hung: capture and video start over on a new one.
    pub device_lost: bool,
    /// The platform's own code, ready for the log (`0x887a0005`).
    pub code: String,
    pub message: String,
}

impl PlatformError {
    pub fn new(message: impl Into<String>) -> PlatformError {
        PlatformError {
            device_lost: false,
            code: String::new(),
            message: message.into(),
        }
    }
}

impl fmt::Display for PlatformError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.code.is_empty() {
            return f.write_str(&self.message);
        }
        write!(f, "{} {}", self.code, self.message)
    }
}

/// A capture of one monitor at a time.
pub trait Source: Send {
    /// Starts capturing `monitor`; frames carry `generation`.
    fn start(&mut self, monitor: &MonitorInfo, generation: u64) -> Result<(), PlatformError>;
    /// Stops capturing. Frames already sent may still arrive; their generation is old.
    fn stop(&mut self);
}

/// What ended a video file early.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VideoError {
    /// The disk is full (`0x80070070`, `STG_E_MEDIUMFULL`).
    Disk(String),
    /// The encoder failed to start or to encode.
    Encoder(String),
    /// Only a software encoder would run, and the test switch doesn't allow one.
    Software,
    /// The graphics device was removed or reset.
    DeviceLost,
}

impl fmt::Display for VideoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VideoError::Disk(e) => write!(f, "the disk is full ({e})"),
            VideoError::Encoder(e) => write!(f, "the encoder failed ({e})"),
            VideoError::Software => f.write_str("no hardware H.264 encoder runs on this computer"),
            VideoError::DeviceLost => f.write_str("the graphics device was lost"),
        }
    }
}

/// How a file is made, including the test faults.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WriterOptions {
    /// The `software-encoder` test switch: the system-memory path into the software encoder.
    pub allow_software: bool,
    /// The `no-hardware` test switch: as if no hardware encoder were installed.
    pub no_hardware: bool,
    /// Meeting time of media time 0, from the file's `video` line.
    pub start_t: u64,
    /// `encoder-fail-at`: from this meeting time every write fails as an encoder error.
    pub encoder_fail_at: Option<u64>,
    /// `write-fail=video@`: from this meeting time the MP4 byte stream's writes fail as on a
    /// full disk (`video::fault`).
    pub disk_fail_at: Option<u64>,
}

/// One video file, as the encoder thread drives it: created on that thread, fed the frames the
/// orchestration decided on, and finished or abandoned when the file ends.
///
/// A frame is written when the next one arrives, so a sample's duration is the real gap to the
/// next: the capture rate varies. Frames held back because the screen is still aren't samples;
/// the newest of them waits for the next re-submit.
pub trait VideoWriter: 'static {
    /// The captured picture this writer takes, the platform's own frame type. It travels to the
    /// encoder's thread, so it must be sendable.
    type Frame: Send;

    /// Writes the frame captured at `boot` (interrupt time). It goes into the file when the next
    /// frame, a re-submit or the end gives its duration.
    fn write(&mut self, frame: &Self::Frame, boot: u64) -> Result<(), VideoError>;
    /// Keeps the frame captured at `boot` for the next re-submit, unless the last frame written is
    /// newer. A newer held frame replaces it; a written one drops it.
    fn hold(&mut self, frame: &Self::Frame, boot: u64);
    /// After a quarter second without a new sample, the held frame goes in at its capture time,
    /// or the last one again at `boot_now`, so a still screen still gets a keyframe and a fragment
    /// boundary every 1 to 2 s.
    fn tick(&mut self, boot_now: u64) -> Result<(), VideoError>;
    /// Writes the held frame, as at the end of the file, so the file ends on the newest picture.
    fn flush(&mut self) -> Result<(), VideoError>;
    /// Writes the last frame, finalizes the file and returns its size. A writer that failed
    /// before is abandoned instead: the file stays readable up to its last fragment.
    fn finish(self) -> Result<u64, VideoError>
    where
        Self: Sized;
    /// Drops the writer without finalizing, as after an error; returns the bytes on disk.
    fn abandon(&mut self) -> u64;
    /// The encoder's name and whether it is hardware.
    fn encoder(&self) -> (&str, bool);
    /// The video's own size, which may differ from the captured frame's.
    fn video_size(&self) -> (u32, u32);
    /// The meeting time where the file's last sample ends.
    fn end_t(&self) -> u64;
}

/// Makes a video file: the platform's encoders and container, for one file at a time.
pub trait VideoMaker: Send + 'static {
    type File: VideoWriter;

    /// Creates `path` (it must not exist) for frames of `width` x `height`, as `options` say. On
    /// failure nothing stays at `path`.
    fn create(
        &mut self,
        path: &Path,
        width: u32,
        height: u32,
        options: WriterOptions,
    ) -> Result<Self::File, VideoError>;
}
