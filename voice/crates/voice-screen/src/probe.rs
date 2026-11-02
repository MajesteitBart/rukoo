//! `rukoo-voice-screen probe`: what this computer can record, for Voice's Settings and CI logs.

use voice_screen_files::caps::Capabilities;
use voice_screen_files::journal::FORMAT_VERSION;

use crate::capture::{monitors_win, wgc};
use crate::frames::ocr;
use crate::video::{encoders, mf};

pub fn probe() -> Capabilities {
    crate::com::init_mta();
    crate::com::dpi_aware();
    let encoders = mf::shared().map(encoders::all_h264).unwrap_or_default();
    let hardware_encoder = encoders.iter().find(|e| e.hardware).cloned();
    Capabilities {
        version: FORMAT_VERSION,
        capture: wgc::supported(),
        encoders,
        hardware_encoder,
        ocr: ocr::languages(),
        monitors: monitors_win::list(),
    }
}
