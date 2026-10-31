//! PCM helpers for Rukoo Voice: conversion to the stored format (16 kHz, mono, signed 16-bit),
//! the crash-safe WAV segment writer, a tolerant WAV reader and segment repair.
//!
//! The meeting folder format these files belong to is described in `voice/RECORDING.md`.

mod resample;
mod wav;

pub use resample::{f32_to_i16, i16_to_f32, to_mono_16k, Resampler};
pub use wav::{
    read_wav, read_wav_i16, repair_segment, segment_header, SegmentWriter, Wav, HEADER_LEN,
    MAX_SEGMENT_SAMPLES,
};

/// The sample rate of every stored track and of the audio the speech models take.
pub const SAMPLE_RATE: u32 = 16_000;
