//! Downmix and sample rate conversion to 16 kHz mono.
//!
//! A windowed-sinc filter evaluated at the exact rational position of every output sample. The
//! position is kept as integers, so an eight-hour recording doesn't drift against the device's
//! own sample count, and the output doesn't depend on how the input was split into blocks.

use crate::SAMPLE_RATE;

/// Zero crossings of the sinc on each side of the centre. With the Blackman window this keeps
/// the stop band far below what a 16-bit speech track can show, at about 110 taps for 48 kHz and
/// 430 for 192 kHz.
const ZERO_CROSSINGS: f64 = 16.0;
/// The -6 dB point as a fraction of the lower of the two Nyquist frequencies. The transition
/// band ends close to Nyquist, so little aliases back into the band the models use.
const CUTOFF: f64 = 0.85;
/// Points per unit of the tabulated kernel shape; linear interpolation between them is far more
/// precise than the 16-bit output.
const SHAPE_POINTS: usize = 4096;
/// Ratios with up to this many phases get a precomputed table of taps. Others, from unusual
/// device rates, compute each output sample's taps when they need them.
const MAX_TABLE_PHASES: u64 = 1024;
/// Consumed input is dropped in batches of at least this many samples.
const DRAIN_BATCH: usize = 8192;

/// Converts one stream of interleaved `f32` frames at a native rate to 16 kHz mono `i16`.
///
/// Feed blocks with [`Resampler::process`] as they arrive. Output sample `n` corresponds to
/// input time `n / 16000` s, so the output starts exactly where the input starts. The filter
/// looks a little ahead, which holds back about a millisecond; [`Resampler::flush`] releases it
/// when the stream ends.
pub struct Resampler {
    rate: u32,
    channels: usize,
    /// An incomplete frame left over from the previous block.
    carry: Vec<f32>,
    filter: Option<Filter>,
}

struct Filter {
    kernel: Kernel,
    /// Output sample `n` sits at input position `n * step_num / kernel.step_den`.
    step_num: u64,
    table: Option<Vec<f32>>,
    row: Vec<f32>,
    /// Mono input; `input[0]` is input sample `first`. It starts with `half` zeros before
    /// sample 0, so the history before the stream reads as silence.
    input: Vec<f32>,
    first: i64,
    received: u64,
    produced: u64,
}

struct Kernel {
    step_den: u64,
    /// Taps on each side of the position; a row has `2 * half` taps.
    half: usize,
    /// Half width of the kernel in input samples.
    width: f64,
    shape: Vec<f32>,
}

impl Resampler {
    /// Returns `None` when the rate or the channel count is zero.
    pub fn new(native_rate: u32, channels: u16) -> Option<Self> {
        if native_rate == 0 || channels == 0 {
            return None;
        }
        let filter = (native_rate != SAMPLE_RATE).then(|| Filter::new(native_rate));
        Some(Self {
            rate: native_rate,
            channels: channels as usize,
            carry: Vec::new(),
            filter,
        })
    }

    pub fn native_rate(&self) -> u32 {
        self.rate
    }

    pub fn channels(&self) -> u16 {
        self.channels as u16
    }

    /// Converts the next block of interleaved frames.
    pub fn process(&mut self, interleaved: &[f32]) -> Vec<i16> {
        let mono = self.downmix(interleaved);
        match &mut self.filter {
            None => mono.into_iter().map(f32_to_i16).collect(),
            Some(filter) => {
                filter.push(&mono);
                let mut out = Vec::with_capacity(
                    (mono.len() as u64 * filter.kernel.step_den / filter.step_num) as usize + 1,
                );
                filter.produce(&mut out, filter.received as i64, u64::MAX);
                filter.drain();
                out
            }
        }
    }

    /// Ends the stream: returns the samples the filter held back, so the output covers exactly
    /// the input's duration, and starts over for a new stream.
    pub fn flush(&mut self) -> Vec<i16> {
        self.carry.clear();
        let Some(filter) = &mut self.filter else {
            return Vec::new();
        };
        let half = filter.kernel.half;
        let total = (filter.received * filter.kernel.step_den).div_ceil(filter.step_num);
        filter.input.extend(std::iter::repeat_n(0.0, half));
        let mut out = Vec::new();
        let limit = filter.received as i64 + half as i64;
        filter.produce(&mut out, limit, total);
        *filter = Filter::new(self.rate);
        out
    }

    fn downmix(&mut self, interleaved: &[f32]) -> Vec<f32> {
        if self.channels == 1 {
            return interleaved.to_vec();
        }
        let mut samples = interleaved;
        let mut mono = Vec::with_capacity(interleaved.len() / self.channels + 1);
        if !self.carry.is_empty() {
            let need = self.channels - self.carry.len();
            let take = need.min(samples.len());
            self.carry.extend_from_slice(&samples[..take]);
            samples = &samples[take..];
            if self.carry.len() < self.channels {
                return mono;
            }
            mono.push(average(&self.carry));
            self.carry.clear();
        }
        let mut frames = samples.chunks_exact(self.channels);
        mono.extend(frames.by_ref().map(average));
        self.carry.extend_from_slice(frames.remainder());
        mono
    }
}

impl Filter {
    fn new(rate: u32) -> Self {
        let g = gcd(rate as u64, SAMPLE_RATE as u64);
        let step_num = rate as u64 / g;
        let step_den = SAMPLE_RATE as u64 / g;
        // Cycles per input sample; for downsampling the output's Nyquist frequency is the limit.
        let cutoff = CUTOFF * 0.5 * (SAMPLE_RATE.min(rate) as f64) / rate as f64;
        let width = ZERO_CROSSINGS / (2.0 * cutoff);
        let half = width.ceil() as usize;
        let kernel = Kernel {
            step_den,
            half,
            width,
            shape: (0..=SHAPE_POINTS)
                .map(|i| kernel_shape(i as f64 / SHAPE_POINTS as f64) as f32)
                .collect(),
        };
        let mut row = vec![0.0; 2 * half];
        let table = (step_den <= MAX_TABLE_PHASES).then(|| {
            let mut table = Vec::with_capacity(step_den as usize * 2 * half);
            for phase in 0..step_den {
                kernel.fill_row(&mut row, phase);
                table.extend_from_slice(&row);
            }
            table
        });
        Self {
            kernel,
            step_num,
            table,
            row,
            input: vec![0.0; half],
            first: -(half as i64),
            received: 0,
            produced: 0,
        }
    }

    fn push(&mut self, mono: &[f32]) {
        self.input.extend_from_slice(mono);
        self.received += mono.len() as u64;
    }

    /// Produces output samples whose taps all lie below input index `limit`, up to `max` in
    /// total.
    fn produce(&mut self, out: &mut Vec<i16>, limit: i64, max: u64) {
        let half = self.kernel.half as i64;
        let step_den = self.kernel.step_den;
        let taps = 2 * self.kernel.half;
        while self.produced < max {
            let pos = self.produced * self.step_num;
            let centre = (pos / step_den) as i64;
            if centre + half >= limit {
                break;
            }
            let phase = pos % step_den;
            let start = (centre - half + 1 - self.first) as usize;
            let window = &self.input[start..start + taps];
            let row = match &self.table {
                Some(table) => {
                    let at = phase as usize * taps;
                    &table[at..at + taps]
                }
                None => {
                    self.kernel.fill_row(&mut self.row, phase);
                    &self.row
                }
            };
            let value: f32 = row.iter().zip(window).map(|(w, x)| w * x).sum();
            out.push(f32_to_i16(value));
            self.produced += 1;
        }
    }

    /// Drops input that no future output sample reaches.
    fn drain(&mut self) {
        let centre = (self.produced * self.step_num / self.kernel.step_den) as i64;
        let keep_from = centre - self.kernel.half as i64 + 1;
        let unused = (keep_from - self.first).max(0) as usize;
        if unused >= DRAIN_BATCH {
            self.input.drain(..unused);
            self.first += unused as i64;
        }
    }
}

impl Kernel {
    /// Taps for the output position `centre + phase / step_den`, normalised so a constant
    /// signal keeps its level at every phase.
    fn fill_row(&self, row: &mut [f32], phase: u64) {
        let frac = phase as f64 / self.step_den as f64;
        let mut sum = 0.0f64;
        for (t, tap) in row.iter_mut().enumerate() {
            let distance = (t as f64 - self.half as f64 + 1.0 - frac).abs();
            let w = lookup(&self.shape, distance / self.width);
            *tap = w;
            sum += w as f64;
        }
        if sum > 0.0 {
            for tap in row.iter_mut() {
                *tap = (*tap as f64 / sum) as f32;
            }
        }
    }
}

/// The kernel at `u` = distance / half width, for `u` in `0..=1`: a sinc with
/// `ZERO_CROSSINGS` zeros on each side under a Blackman window.
fn kernel_shape(u: f64) -> f64 {
    use std::f64::consts::PI;
    let x = ZERO_CROSSINGS * u;
    let sinc = if x == 0.0 {
        1.0
    } else {
        (PI * x).sin() / (PI * x)
    };
    let window = 0.42 + 0.5 * (PI * u).cos() + 0.08 * (2.0 * PI * u).cos();
    sinc * window.max(0.0)
}

fn lookup(shape: &[f32], u: f64) -> f32 {
    if u >= 1.0 {
        return 0.0;
    }
    let scaled = u * SHAPE_POINTS as f64;
    let i = scaled as usize;
    let frac = (scaled - i as f64) as f32;
    shape[i] + (shape[i + 1] - shape[i]) * frac
}

fn average(frame: &[f32]) -> f32 {
    frame.iter().sum::<f32>() / frame.len() as f32
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// Converts a sample in `-1.0..=1.0` to `i16`, clipping beyond full scale. NaN becomes 0.
pub fn f32_to_i16(x: f32) -> i16 {
    (x.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

pub fn i16_to_f32(x: i16) -> f32 {
    x as f32 / 32768.0
}

/// Converts a whole buffer of interleaved frames in one go. Returns `None` when the rate or the
/// channel count is zero.
pub fn to_mono_16k(interleaved: &[f32], native_rate: u32, channels: u16) -> Option<Vec<i16>> {
    let mut resampler = Resampler::new(native_rate, channels)?;
    let mut out = resampler.process(interleaved);
    out.extend(resampler.flush());
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;

    fn tone(rate: u32, channels: u16, hz: f32, seconds: f32, amplitude: f32) -> Vec<f32> {
        let frames = (rate as f32 * seconds) as usize;
        let mut out = Vec::with_capacity(frames * channels as usize);
        for n in 0..frames {
            let v = amplitude * (TAU * hz * n as f32 / rate as f32).sin();
            out.extend(std::iter::repeat_n(v, channels as usize));
        }
        out
    }

    fn rms(samples: &[i16]) -> f64 {
        let sum: f64 = samples.iter().map(|&s| (s as f64).powi(2)).sum();
        (sum / samples.len() as f64).sqrt()
    }

    /// Sign changes per second, which is twice the frequency of a clean tone.
    fn crossings_per_second(samples: &[i16]) -> f64 {
        let changes = samples
            .windows(2)
            .filter(|w| (w[0] < 0) != (w[1] < 0))
            .count();
        changes as f64 * SAMPLE_RATE as f64 / samples.len() as f64
    }

    #[test]
    fn rejects_zero_rate_or_channels() {
        assert!(Resampler::new(0, 1).is_none());
        assert!(Resampler::new(48_000, 0).is_none());
    }

    #[test]
    fn passes_16k_mono_through_unchanged() {
        let input: Vec<f32> = (0..1000).map(|i| (i as f32 / 1000.0) - 0.5).collect();
        let out = to_mono_16k(&input, 16_000, 1).unwrap();
        let expected: Vec<i16> = input.iter().copied().map(f32_to_i16).collect();
        assert_eq!(out, expected);
    }

    #[test]
    fn keeps_level_and_pitch_from_common_device_rates() {
        for (rate, channels) in [
            (48_000, 2),
            (44_100, 2),
            (192_000, 2),
            (8_000, 1),
            (22_050, 1),
        ] {
            let input = tone(rate, channels, 440.0, 2.0, 0.5);
            let out = to_mono_16k(&input, rate, channels).unwrap();
            assert_eq!(out.len(), 32_000, "{rate} Hz gives 2 s at 16 kHz");
            // Skip the edges, where the filter sees silence before and after the stream.
            let middle = &out[1600..30_400];
            let expected_rms = 0.5 * 32767.0 / 2f64.sqrt();
            let level = rms(middle) / expected_rms;
            assert!(
                (0.99..1.01).contains(&level),
                "{rate} Hz level ratio {level}"
            );
            let cps = crossings_per_second(middle);
            assert!(
                (cps - 880.0).abs() < 3.0,
                "{rate} Hz gives {cps} crossings/s"
            );
        }
    }

    #[test]
    fn output_starts_where_the_input_starts() {
        // A step from silence to half scale at 0.5 s must land at 0.5 s in the output.
        let rate = 48_000;
        let mut input = vec![0.0f32; rate as usize / 2];
        input.extend(std::iter::repeat_n(0.5f32, rate as usize / 2));
        let out = to_mono_16k(&input, rate, 1).unwrap();
        let rise = out.iter().position(|&s| s > 16_383 / 2).unwrap();
        assert!((7_999..=8_001).contains(&rise), "step lands at {rise}");
    }

    #[test]
    fn attenuates_content_above_the_new_nyquist_frequency() {
        // 12 kHz at 48 kHz would alias to 4 kHz without the filter.
        let input = tone(48_000, 1, 12_000.0, 1.0, 0.5);
        let out = to_mono_16k(&input, 48_000, 1).unwrap();
        let level = rms(&out[800..15_200]);
        let full = 0.5 * 32767.0 / 2f64.sqrt();
        let db = 20.0 * (level.max(1e-9) / full).log10();
        assert!(db < -60.0, "aliased level {db} dB");
    }

    #[test]
    fn block_size_does_not_change_the_output() {
        // 44,056 Hz has 2000 phases, so it takes the path without a table.
        for rate in [44_100, 48_000, 44_056] {
            let input = tone(rate, 2, 1000.0, 1.3, 0.4);
            let whole = to_mono_16k(&input, rate, 2).unwrap();
            let mut resampler = Resampler::new(rate, 2).unwrap();
            let mut pieces = Vec::new();
            // Odd block sizes, including blocks that split a stereo frame.
            for block in input.chunks(333) {
                pieces.extend(resampler.process(block));
            }
            pieces.extend(resampler.flush());
            assert_eq!(pieces, whole, "{rate} Hz");
        }
    }

    #[test]
    fn output_length_matches_the_input_duration_after_flush() {
        for (rate, frames) in [
            (44_100u32, 44_101usize),
            (48_000, 1),
            (192_000, 12_345),
            (8_000, 3),
        ] {
            let input = vec![0.1f32; frames];
            let out = to_mono_16k(&input, rate, 1).unwrap();
            let expected = (frames as u64 * 16_000).div_ceil(rate as u64) as usize;
            assert_eq!(out.len(), expected, "{rate} Hz, {frames} frames");
        }
    }

    #[test]
    fn flush_starts_a_new_stream() {
        let input = tone(48_000, 1, 440.0, 0.5, 0.5);
        let mut resampler = Resampler::new(48_000, 1).unwrap();
        let mut first = resampler.process(&input);
        first.extend(resampler.flush());
        let mut second = resampler.process(&input);
        second.extend(resampler.flush());
        assert_eq!(first, second);
    }

    #[test]
    fn clips_beyond_full_scale() {
        assert_eq!(f32_to_i16(2.0), 32767);
        assert_eq!(f32_to_i16(-2.0), -32767);
        assert_eq!(f32_to_i16(f32::NAN), 0);
        assert_eq!(f32_to_i16(0.0), 0);
    }
}
