//! What `rukoo-voice-screen probe` prints, and the video size rule.

use serde::{Deserialize, Serialize};

use crate::monitors::MonitorInfo;

/// A Media Foundation H.264 encoder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderInfo {
    pub name: String,
    pub hardware: bool,
    pub vendor: Option<String>,
}

/// What this computer can record. `ocr` holds the OCR languages as BCP-47 tags.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub version: u32,
    pub capture: bool,
    pub encoders: Vec<EncoderInfo>,
    pub hardware_encoder: Option<EncoderInfo>,
    pub ocr: Vec<String>,
    pub monitors: Vec<MonitorInfo>,
}

/// The longest side the encoder takes (NVENC on Pascal).
pub const MAX_VIDEO_SIDE: u32 = 4096;
/// The most 16 x 16 macroblocks in a frame at H.264 level 5.1.
pub const MAX_MACROBLOCKS: u32 = 36_864;

/// The video size for a monitor: its own size when each side is at most `MAX_VIDEO_SIDE` and
/// the frame at most `MAX_MACROBLOCKS`, else scaled by one factor to fit both; then both sides
/// rounded down to even. 1440 x 2560 stays; 5120 x 1440 becomes 4096 x 1152.
pub fn video_size(width: u32, height: u32) -> (u32, u32) {
    let _ = (width, height);
    todo!()
}
