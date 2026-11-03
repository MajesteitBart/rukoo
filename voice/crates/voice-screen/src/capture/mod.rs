//! Where frames come from: Windows.Graphics.Capture on one monitor, or the synthetic screen of
//! the tests and live runs. Both copy each frame into a texture the process owns and hand it to
//! the main thread.

pub mod d3d;
pub mod monitors_win;
pub mod session;
pub mod synthetic;
pub mod wgc;

use voice_screen_files::monitors::MonitorInfo;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

use self::d3d::D3D;

/// A captured frame, copied out of the capture's own buffers. `width` and `height` are even
/// (an odd last column or row is cropped). `boot` is when it was composed, in interrupt time.
/// `dirty` is the fraction of the screen its dirty regions cover, where Windows reports them.
/// `generation` names the capture session, so frames of a stopped one are dropped.
#[derive(Clone)]
pub struct CapturedFrame {
    pub texture: ID3D11Texture2D,
    pub boot: u64,
    pub width: u32,
    pub height: u32,
    pub dirty: Option<f32>,
    pub generation: u64,
}

// The texture is free-threaded and only read after the copy.
unsafe impl Send for CapturedFrame {}

/// A capture of one monitor at a time.
pub trait Source: Send {
    /// Starts capturing `monitor`; frames carry `generation`.
    fn start(&mut self, monitor: &MonitorInfo, generation: u64) -> windows::core::Result<()>;
    /// Stops capturing. Frames already sent may still arrive; their generation is old.
    fn stop(&mut self);
    fn device(&self) -> &D3D;
}
