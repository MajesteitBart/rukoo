//! One fragmented MP4 file through Media Foundation's sink writer.
//!
//! Two sample paths (spec 2.5). The GPU path, when the device has video support and a hardware
//! H.264 encoder is there: the sink writer gets the device through a DXGI device manager and
//! each sample wraps the captured texture, so NVENC reads it without a copy. The system-memory
//! path otherwise, and with the `software-encoder` test switch: each frame is mapped through a
//! staging texture and copied row by row into a memory buffer, which Microsoft's software
//! encoder takes on a CI runner that has only WARP.
//!
//! A frame is written when the next one arrives, so each sample's duration is the real gap to
//! the next: the capture rate varies. A still screen re-submits its last frame every second, and
//! a keyframe is forced at least every second of media time, so fragments stay 1 to 2 s long and
//! a hard kill loses at most the open one.

use std::path::{Path, PathBuf};

use voice_screen_files::caps::video_size;
use windows::core::{Interface, GUID, HSTRING};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Variant::VARIANT;

use super::encoders;
use super::mf::Mf;
use super::FPS;
use crate::capture::d3d::{is_device_lost, D3D};

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

impl std::fmt::Display for VideoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
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
    /// `write-fail=video@`: from this meeting time every write fails as a full disk.
    pub disk_fail_at: Option<u64>,
}

/// One second in 100 ns units: the longest a frame stays without a re-submit, and the most
/// media time between keyframes.
const SECOND: i64 = 10_000_000;
/// The duration of the last sample when the file ends.
const LAST_DURATION: i64 = SECOND / FPS as i64;

pub struct VideoWriter {
    mf: &'static Mf,
    d3d: D3D,
    writer: Option<IMFSinkWriter>,
    stream: u32,
    codec: Option<ICodecAPI>,
    gpu: bool,
    staging: Option<ID3D11Texture2D>,
    width: u32,
    height: u32,
    video_width: u32,
    video_height: u32,
    start_boot: Option<u64>,
    last_key: Option<i64>,
    pending: Option<(ID3D11Texture2D, i64)>,
    last_time: Option<i64>,
    last_texture: Option<ID3D11Texture2D>,
    path: PathBuf,
    encoder: String,
    hardware: bool,
    options: WriterOptions,
}

impl VideoWriter {
    /// Creates `path` (it must not exist) for frames of `width` x `height`; the video gets the
    /// size of `caps::video_size`, which the sink writer's video processor scales to. On failure
    /// nothing stays at `path`.
    pub fn create(
        mf: &'static Mf,
        d3d: &D3D,
        path: &Path,
        width: u32,
        height: u32,
        options: WriterOptions,
    ) -> Result<VideoWriter, VideoError> {
        let hardware_encoders = if options.no_hardware {
            Vec::new()
        } else {
            encoders::hardware_h264(mf)
        };
        if hardware_encoders.is_empty() && !options.allow_software {
            return Err(VideoError::Software);
        }
        let gpu = d3d.video && !hardware_encoders.is_empty() && !options.allow_software;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| match crate::disk::is_disk_full(&e) {
                true => VideoError::Disk(e.to_string()),
                false => VideoError::Encoder(format!("can't create the video folder: {e}")),
            })?;
        }
        let (video_width, video_height) = video_size(width, height);
        let mut writer = VideoWriter {
            mf,
            d3d: d3d.clone(),
            writer: None,
            stream: 0,
            codec: None,
            gpu,
            staging: None,
            width,
            height,
            video_width,
            video_height,
            start_boot: None,
            last_key: None,
            pending: None,
            last_time: None,
            last_texture: None,
            path: path.to_path_buf(),
            encoder: String::new(),
            hardware: false,
            options,
        };
        match writer.open(&hardware_encoders) {
            Ok(()) => Ok(writer),
            Err(e) => {
                writer.abandon();
                let _ = std::fs::remove_file(path);
                Err(e)
            }
        }
    }

    fn open(
        &mut self,
        hardware_encoders: &[voice_screen_files::caps::EncoderInfo],
    ) -> Result<(), VideoError> {
        let mf = self.mf;
        let url = HSTRING::from(self.path.as_os_str());
        // Fail-if-exists, and Media Foundation shares the file for reading, so `clip.get` can
        // cut the fragments already written (spike 1).
        let bytes = mf
            .create_file(
                MF_ACCESSMODE_WRITE,
                MF_OPENMODE_FAIL_IF_EXIST,
                MF_FILEFLAGS_NONE,
                &url,
            )
            .map_err(classify)?;
        unsafe {
            let attributes = mf.create_attributes(6).map_err(classify)?;
            attributes
                .SetGUID(
                    &MF_TRANSCODE_CONTAINERTYPE,
                    &MFTranscodeContainerType_FMPEG4,
                )
                .map_err(classify)?;
            attributes
                .SetUINT32(
                    &MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
                    u32::from(self.gpu),
                )
                .map_err(classify)?;
            if self.gpu {
                let (token, manager) = mf.create_dxgi_device_manager().map_err(classify)?;
                manager
                    .ResetDevice(&self.d3d.device, token)
                    .map_err(classify)?;
                attributes
                    .SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, &manager)
                    .map_err(classify)?;
            }
            attributes
                .SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)
                .map_err(classify)?;
            attributes
                .SetUINT64(&MF_MPEG4SINK_MIN_FRAGMENT_DURATION, SECOND as u64)
                .map_err(classify)?;
            let writer = mf
                .create_sink_writer(&bytes, &attributes)
                .map_err(classify)?;
            self.writer = Some(writer.clone());

            let pixels = u64::from(self.video_width) * u64::from(self.video_height);
            let output = mf.create_media_type().map_err(classify)?;
            output
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .map_err(classify)?;
            output
                .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)
                .map_err(classify)?;
            output
                .SetUINT32(&MF_MT_AVG_BITRATE, (pixels * 2).min(8_000_000) as u32)
                .map_err(classify)?;
            output
                .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .map_err(classify)?;
            output
                .SetUINT64(&MF_MT_FRAME_SIZE, pack(self.video_width, self.video_height))
                .map_err(classify)?;
            output
                .SetUINT64(&MF_MT_FRAME_RATE, pack(FPS, 1))
                .map_err(classify)?;
            output
                .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))
                .map_err(classify)?;
            output
                .SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)
                .map_err(classify)?;
            self.stream = writer.AddStream(&output).map_err(classify)?;

            let input = mf.create_media_type().map_err(classify)?;
            input
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .map_err(classify)?;
            input
                .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_ARGB32)
                .map_err(classify)?;
            input
                .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .map_err(classify)?;
            input
                .SetUINT64(&MF_MT_FRAME_SIZE, pack(self.width, self.height))
                .map_err(classify)?;
            input
                .SetUINT64(&MF_MT_FRAME_RATE, pack(FPS, 1))
                .map_err(classify)?;
            input
                .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))
                .map_err(classify)?;
            // Positive stride: rows run top-down, as in the texture.
            input
                .SetUINT32(&MF_MT_DEFAULT_STRIDE, self.width * 4)
                .map_err(classify)?;
            writer
                .SetInputMediaType(self.stream, &input, None)
                .map_err(classify)?;

            let mut codec = std::ptr::null_mut();
            if writer
                .GetServiceForStream(self.stream, &GUID::zeroed(), &ICodecAPI::IID, &mut codec)
                .is_ok()
                && !codec.is_null()
            {
                let codec = ICodecAPI::from_raw(codec);
                for (api, value) in [
                    (
                        CODECAPI_AVEncCommonRateControlMode,
                        eAVEncCommonRateControlMode_Quality.0 as u32,
                    ),
                    (CODECAPI_AVEncCommonQuality, 60),
                    (CODECAPI_AVLowLatencyMode, 1),
                    (CODECAPI_AVEncMPVGOPSize, 0),
                ] {
                    // An encoder that refuses one of these still records.
                    let _ = codec.SetValue(&api, &VARIANT::from(value));
                }
                self.codec = Some(codec);
            }
            writer.BeginWriting().map_err(classify)?;
            self.identify(&writer, hardware_encoders);
        }
        if !self.hardware && !self.options.allow_software {
            return Err(VideoError::Software);
        }
        if !self.gpu {
            self.staging = Some(
                self.d3d
                    .staging(self.width, self.height)
                    .map_err(classify)?,
            );
        }
        Ok(())
    }

    /// Which encoder the sink writer loaded: a transform without a hardware vendor id is
    /// software, whatever was asked for.
    fn identify(
        &mut self,
        writer: &IMFSinkWriter,
        hardware_encoders: &[voice_screen_files::caps::EncoderInfo],
    ) {
        let mut found = None;
        if let Ok(ex) = writer.cast::<IMFSinkWriterEx>() {
            for index in 0..8 {
                let mut category = GUID::zeroed();
                let mut transform: Option<IMFTransform> = None;
                if unsafe {
                    ex.GetTransformForStream(
                        self.stream,
                        index,
                        Some(&mut category),
                        &mut transform,
                    )
                }
                .is_err()
                {
                    break;
                }
                if category == MFT_CATEGORY_VIDEO_ENCODER {
                    found = transform;
                }
            }
        }
        let (name, vendor) = match found.and_then(|t| unsafe { t.GetAttributes() }.ok()) {
            Some(attributes) => (
                Mf::string_attribute(&attributes, &MFT_FRIENDLY_NAME_Attribute),
                Mf::string_attribute(&attributes, &MFT_ENUM_HARDWARE_VENDOR_ID_Attribute),
            ),
            // No answer from the sink writer: trust the path it was given.
            None => (None, self.gpu.then(String::new)),
        };
        self.hardware = vendor.is_some();
        let by_vendor = vendor.as_deref().and_then(|v| {
            hardware_encoders
                .iter()
                .find(|e| !v.is_empty() && e.vendor.as_deref() == Some(v))
                .or(hardware_encoders.first())
        });
        self.encoder = name
            .or_else(|| by_vendor.map(|e| e.name.clone()))
            .unwrap_or_else(|| match self.hardware {
                true => "Hardware H.264 encoder".into(),
                false => "H264 Encoder MFT".into(),
            });
    }

    /// The encoder's name and whether it is hardware.
    pub fn encoder(&self) -> (&str, bool) {
        (&self.encoder, self.hardware)
    }

    /// The video's own size.
    pub fn video_size(&self) -> (u32, u32) {
        (self.video_width, self.video_height)
    }

    /// The frame captured at `boot` (interrupt time). It goes into the file when the next frame,
    /// a re-submit or the end gives its duration.
    pub fn write(&mut self, texture: &ID3D11Texture2D, boot: u64) -> Result<(), VideoError> {
        let start = *self.start_boot.get_or_insert(boot);
        let mut time = boot.saturating_sub(start) as i64;
        if let Some(last) = self.last_time {
            if time <= last {
                time = last + 1;
            }
        }
        let at = self.options.start_t + time as u64 / 10_000;
        if self.options.encoder_fail_at.is_some_and(|ms| at >= ms) {
            return Err(VideoError::Encoder("encoder-fail-at test switch".into()));
        }
        if self.options.disk_fail_at.is_some_and(|ms| at >= ms) {
            return Err(VideoError::Disk(
                "0x80070070, write-fail test switch".into(),
            ));
        }
        if let Some((previous, previous_time)) = self.pending.take() {
            self.emit(&previous, previous_time, time - previous_time)?;
        }
        self.pending = Some((texture.clone(), time));
        self.last_time = Some(time);
        self.last_texture = Some(texture.clone());
        Ok(())
    }

    /// After a second without a new frame, the last one goes in again at `boot_now`, so a still
    /// screen still gets a keyframe and a fragment boundary every second or two.
    pub fn tick(&mut self, boot_now: u64) -> Result<(), VideoError> {
        let (Some(start), Some(last), Some(texture)) =
            (self.start_boot, self.last_time, self.last_texture.clone())
        else {
            return Ok(());
        };
        let now = boot_now.saturating_sub(start) as i64;
        if now - last >= SECOND {
            self.write(&texture, boot_now)?;
        }
        Ok(())
    }

    fn emit(
        &mut self,
        texture: &ID3D11Texture2D,
        time: i64,
        duration: i64,
    ) -> Result<(), VideoError> {
        let writer = self
            .writer
            .clone()
            .ok_or(VideoError::Encoder("closed".into()))?;
        let buffer = self.buffer(texture)?;
        unsafe {
            let sample = self.mf.create_sample().map_err(classify)?;
            sample.AddBuffer(&buffer).map_err(classify)?;
            sample.SetSampleTime(time).map_err(classify)?;
            sample
                .SetSampleDuration(duration.max(1))
                .map_err(classify)?;
            if self.last_key.is_none_or(|key| time - key >= SECOND) {
                if let Some(codec) = &self.codec {
                    let _ = codec.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32));
                }
                self.last_key = Some(time);
            }
            writer.WriteSample(self.stream, &sample).map_err(classify)?;
        }
        Ok(())
    }

    fn buffer(&self, texture: &ID3D11Texture2D) -> Result<IMFMediaBuffer, VideoError> {
        if self.gpu {
            let buffer = self
                .mf
                .create_dxgi_surface_buffer(texture)
                .map_err(classify)?;
            unsafe {
                let len = buffer
                    .cast::<IMF2DBuffer>()
                    .and_then(|b| b.GetContiguousLength())
                    .map_err(classify)?;
                buffer.SetCurrentLength(len).map_err(classify)?;
            }
            return Ok(buffer);
        }
        let staging = self
            .staging
            .as_ref()
            .ok_or(VideoError::Encoder("no staging texture".into()))?;
        let row = self.width as usize * 4;
        let len = (row * self.height as usize) as u32;
        let buffer = self.mf.create_memory_buffer(len).map_err(classify)?;
        unsafe {
            let mut data = std::ptr::null_mut();
            buffer.Lock(&mut data, None, None).map_err(classify)?;
            let copied =
                self.d3d
                    .read_rows(staging, texture, self.width, self.height, |y, bytes| {
                        std::ptr::copy_nonoverlapping(bytes.as_ptr(), data.add(y * row), row);
                    });
            let _ = buffer.Unlock();
            copied.map_err(classify)?;
            buffer.SetCurrentLength(len).map_err(classify)?;
        }
        Ok(buffer)
    }

    /// The meeting time where the file's last sample ends.
    pub fn end_t(&self) -> u64 {
        match self.last_time {
            Some(last) => self.options.start_t + (last + LAST_DURATION) as u64 / 10_000,
            None => self.options.start_t,
        }
    }

    /// Writes the last frame, finalizes the file and returns its size. A writer that failed
    /// before is abandoned instead: the file stays readable up to its last fragment.
    pub fn finish(mut self) -> Result<u64, VideoError> {
        let mut result = Ok(());
        if let Some((texture, time)) = self.pending.take() {
            result = self.emit(&texture, time, LAST_DURATION);
        }
        if let Some(writer) = self.writer.take() {
            let finalized = unsafe { writer.Finalize() }.map_err(classify);
            result = result.and(finalized);
        }
        let bytes = std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        result.map(|()| bytes)
    }

    /// Drops the sink writer without `Finalize`, as after an error; returns the bytes on disk.
    pub fn abandon(&mut self) -> u64 {
        self.pending = None;
        self.writer = None;
        self.codec = None;
        std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0)
    }
}

fn pack(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

/// Sorts a Media Foundation or Direct3D error into what the drop order needs.
pub fn classify(e: windows::core::Error) -> VideoError {
    let code = e.code().0 as u32;
    if is_device_lost(&e) {
        VideoError::DeviceLost
    } else if matches!(code, 0x8007_0070 | 0x8003_0070 | 0x8007_0027) {
        VideoError::Disk(format!("{code:#010x}"))
    } else {
        VideoError::Encoder(format!("{code:#010x} {}", e.message()))
    }
}
