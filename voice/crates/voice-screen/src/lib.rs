//! The Rukoo Voice screen recorder: captures one monitor into the meeting's `screen/` folder as
//! frames with the text on them and, in video mode, a fragmented MP4, on the recorder's meeting
//! clock (`voice/RECORDING.md`, "The screen folder").
//!
//! The binary `rukoo-voice-screen` runs as its own process, so a graphics driver, encoder or OCR
//! crash never costs audio.

use std::fmt;

/// The screen process's own version, written into `session` lines.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Exit codes of `rukoo-voice-screen`, as the recorder's.
pub mod exit {
    /// Anything else, such as a disk error at start, or a pinned monitor that isn't there.
    pub const FAILED: i32 = 1;
    /// The arguments are wrong, or the command can't run on this platform.
    pub const USAGE: i32 = 2;
    /// The screen folder's state doesn't allow it: a journal with `stop`, or content without
    /// `--resume`.
    pub const CONFLICT: i32 = 3;
    /// Another screen process is recording into this meeting.
    pub const BUSY: i32 = 4;
}

#[derive(Debug)]
pub struct ExitError {
    pub code: i32,
    pub message: String,
}

impl ExitError {
    pub fn usage(message: impl Into<String>) -> Self {
        Self {
            code: exit::USAGE,
            message: message.into(),
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            code: exit::CONFLICT,
            message: message.into(),
        }
    }

    pub fn busy() -> Self {
        Self {
            code: exit::BUSY,
            message: "another screen process is recording into this meeting".into(),
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            code: exit::FAILED,
            message: message.into(),
        }
    }
}

impl fmt::Display for ExitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// Runs one command line (without the program name):
///
/// ```text
/// rukoo-voice-screen record   --meeting <dir> --mode frames|video [--resume] [--monitor <id>] [--test <spec>]
/// rukoo-voice-screen finalize --meeting <dir> [--reason interrupted|failed]
/// rukoo-voice-screen probe
/// rukoo-voice-screen inspect <file.mp4>
/// ```
///
/// Tests call this from their own binary to play the screen process.
pub fn run(args: &[String]) -> Result<(), ExitError> {
    let _ = args;
    todo!()
}
