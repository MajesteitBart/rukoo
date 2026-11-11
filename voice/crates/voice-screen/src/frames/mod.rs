//! Frames: a small luma thumbnail of each captured frame decides with
//! `voice_screen_files::frames::Saver` which ones to keep; a kept frame becomes a JPEG and the
//! text Windows reads on it.

pub mod worker;

#[cfg(windows)]
pub mod jpeg;
#[cfg(windows)]
pub mod ocr;
#[cfg(windows)]
pub mod thumb;
