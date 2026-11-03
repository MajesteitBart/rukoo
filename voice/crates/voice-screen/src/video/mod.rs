//! Hardware H.264 into fragmented MP4 through Media Foundation's sink writer, one file per
//! continuous stretch of video.

pub mod size;

#[cfg(windows)]
pub mod encoders;
#[cfg(windows)]
pub mod fault;
#[cfg(windows)]
pub mod mf;
#[cfg(windows)]
pub mod thread;
#[cfg(windows)]
pub mod writer;

/// The nominal frame rate written into the media types; the real rate is variable, at most this.
pub const FPS: u32 = 15;
