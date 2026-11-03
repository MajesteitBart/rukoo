//! The H.264 encoders Media Foundation knows on this computer.

use voice_screen_files::caps::EncoderInfo;
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, MFMediaType_Video, MFT_ENUM_HARDWARE_VENDOR_ID_Attribute,
    MFT_FRIENDLY_NAME_Attribute, MFVideoFormat_H264, MFT_CATEGORY_VIDEO_ENCODER,
    MFT_ENUM_FLAG_ASYNCMFT, MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER,
    MFT_ENUM_FLAG_SYNCMFT, MFT_REGISTER_TYPE_INFO,
};

use super::mf::Mf;

/// Hardware H.264 encoders, best first: `MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER,
/// MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, ..)`. NVENC on this PC.
pub fn hardware_h264(mf: &Mf) -> Vec<EncoderInfo> {
    list(
        mf,
        (MFT_ENUM_FLAG_HARDWARE.0 | MFT_ENUM_FLAG_SORTANDFILTER.0) as u32,
        true,
    )
}

/// Software H.264 encoders, such as Microsoft's "H264 Encoder MFT".
pub fn software_h264(mf: &Mf) -> Vec<EncoderInfo> {
    list(
        mf,
        (MFT_ENUM_FLAG_SYNCMFT.0 | MFT_ENUM_FLAG_ASYNCMFT.0 | MFT_ENUM_FLAG_SORTANDFILTER.0) as u32,
        false,
    )
}

/// Hardware first, then software.
pub fn all_h264(mf: &Mf) -> Vec<EncoderInfo> {
    let mut all = hardware_h264(mf);
    all.extend(software_h264(mf));
    all
}

fn list(mf: &Mf, flags: u32, hardware: bool) -> Vec<EncoderInfo> {
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    match mf.enum_transforms(MFT_CATEGORY_VIDEO_ENCODER, flags, &output) {
        Ok(found) => found.iter().map(|a| info(a, hardware)).collect(),
        Err(e) => {
            crate::log(format_args!(
                "listing H.264 encoders failed: {:#010x}",
                e.code().0
            ));
            Vec::new()
        }
    }
}

fn info(activate: &IMFActivate, hardware: bool) -> EncoderInfo {
    let vendor = Mf::string_attribute(activate, &MFT_ENUM_HARDWARE_VENDOR_ID_Attribute);
    EncoderInfo {
        name: Mf::string_attribute(activate, &MFT_FRIENDLY_NAME_Attribute)
            .unwrap_or_else(|| "H.264 encoder".into()),
        hardware: hardware || vendor.is_some(),
        vendor,
    }
}
