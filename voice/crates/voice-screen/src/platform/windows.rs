//! The Windows backend: Direct3D 11 for capture, thumbnails and pixels, Media Foundation for
//! video, WinRT for JPEG and OCR.

use crate::capture::d3d::is_device_lost;

use super::PlatformError;

impl From<windows::core::Error> for PlatformError {
    fn from(e: windows::core::Error) -> PlatformError {
        PlatformError {
            device_lost: is_device_lost(&e),
            code: format!("{:#010x}", e.code().0),
            message: e.message(),
        }
    }
}
