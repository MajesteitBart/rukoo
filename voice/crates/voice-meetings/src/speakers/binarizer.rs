//! Turns the frame probabilities a diarizer stream commits into speaker turn events that never
//! change once they are reported, so stored turns are never rewritten.
//!
//! A line-by-line port of Ownkey's `LiveBinarizer` (`local_diarization.py:260-338`), which is a
//! causal copy of NeMo-Speech.cpp's segment postprocessing (`diar_segments_from_probs`): onset
//! and offset hysteresis, padding at both edges, filling short gaps and dropping short runs. Fed
//! the same frames, its events equal the batch segments.
//!
//! Probabilities are `f32` and compared with `f32` thresholds, as NumPy 2 compares a float32
//! frame with a Python float; times are `f64` seconds of the stream.

/// The postprocessing thresholds. The defaults are NeMo-Speech.cpp's `DiarSegmentationCfg`
/// (`diar_pipeline.h:101-108`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BinarizerParams {
    /// A speaker turns on above this probability.
    pub onset: f32,
    /// And off below this one.
    pub offset: f32,
    /// Seconds a turn starts before its first frame.
    pub pad_onset: f64,
    /// Seconds a turn ends after its last frame.
    pub pad_offset: f64,
    /// Turns shorter than this are dropped.
    pub min_on: f64,
    /// Gaps shorter than this are filled.
    pub min_off: f64,
}

impl Default for BinarizerParams {
    fn default() -> BinarizerParams {
        BinarizerParams {
            onset: 0.641,
            offset: 0.561,
            pad_onset: 0.229,
            pad_offset: 0.079,
            min_on: 0.511,
            min_off: 0.296,
        }
    }
}

/// A speaker started or stopped talking at `seconds` of the stream.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TurnEvent {
    /// The stream's speaker index.
    pub speaker: usize,
    pub seconds: f64,
    pub starting: bool,
}

/// One speaker's run of frames above the onset, in frames.
#[derive(Clone, Copy, Debug)]
struct Run {
    start: u64,
    /// The frame the run fell below the offset; `None` while it is on.
    end: Option<u64>,
    /// Whether its start was reported.
    confirmed: bool,
}

/// The causal postprocessing of one stream.
#[derive(Clone, Debug)]
pub struct LiveBinarizer {
    spf: f64,
    params: BinarizerParams,
    frame: u64,
    raw: Vec<bool>,
    open: Vec<Option<Run>>,
}

impl LiveBinarizer {
    pub fn new(speakers: usize, seconds_per_frame: f64, params: BinarizerParams) -> LiveBinarizer {
        LiveBinarizer {
            spf: seconds_per_frame,
            params,
            frame: 0,
            raw: vec![false; speakers],
            open: vec![None; speakers],
        }
    }

    fn start_of(&self, run: &Run) -> f64 {
        (run.start as f64 * self.spf - self.params.pad_onset).max(0.0)
    }

    /// The padded end of a run that fell below the offset.
    fn end_of(&self, end: u64) -> f64 {
        end as f64 * self.spf + self.params.pad_offset
    }

    /// The stream time before which every start and end has been reported.
    pub fn settled_seconds(&self) -> f64 {
        let p = &self.params;
        let mut settled = self.frame as f64 * self.spf - p.min_on.max(p.pad_onset + p.min_off);
        for run in self.open.iter().flatten() {
            if !run.confirmed {
                settled = settled.min(self.start_of(run));
            }
        }
        settled.max(0.0)
    }

    fn gap_closed(&self, end: u64, frame: u64) -> bool {
        (frame as f64 * self.spf - self.params.pad_onset) - self.end_of(end) >= self.params.min_off
    }

    /// Reports the run's start once it has lasted the minimum duration.
    fn confirm(&self, run: &mut Run, speaker: usize, end: f64, events: &mut Vec<TurnEvent>) {
        let start = self.start_of(run);
        if !run.confirmed && end - start >= self.params.min_on {
            run.confirmed = true;
            events.push(TurnEvent {
                speaker,
                seconds: start,
                starting: true,
            });
        }
    }

    /// Takes the next frames, frame-major, `speakers` values per frame. Returns the events they
    /// settle.
    pub fn feed(&mut self, probs: &[f32]) -> Vec<TurnEvent> {
        let speakers = self.raw.len();
        let mut events = Vec::new();
        if speakers == 0 {
            return events;
        }
        for row in probs.chunks_exact(speakers) {
            for (speaker, &p) in row.iter().enumerate() {
                if !self.raw[speaker] && p > self.params.onset {
                    self.raw[speaker] = true;
                    match self.open[speaker].as_mut() {
                        // The gap is short enough to fill, as the runtime merges it.
                        Some(run) => run.end = None,
                        None => {
                            self.open[speaker] = Some(Run {
                                start: self.frame,
                                end: None,
                                confirmed: false,
                            })
                        }
                    }
                } else if self.raw[speaker] && p < self.params.offset {
                    self.raw[speaker] = false;
                    if let Some(run) = self.open[speaker].as_mut() {
                        run.end = Some(self.frame);
                    }
                }
                let Some(mut run) = self.open[speaker] else {
                    continue;
                };
                let seen = (self.frame + 1) as f64 * self.spf;
                let end = match run.end {
                    Some(end) => seen.min(self.end_of(end)),
                    None => seen,
                };
                self.confirm(&mut run, speaker, end, &mut events);
                self.open[speaker] = Some(run);
                if let Some(end) = run.end {
                    if self.gap_closed(end, self.frame + 1) {
                        if run.confirmed {
                            events.push(TurnEvent {
                                speaker,
                                seconds: self.end_of(end),
                                starting: false,
                            });
                        }
                        self.open[speaker] = None;
                    }
                }
            }
            self.frame += 1;
        }
        events
    }

    /// Ends every open turn at the last frame, for a stream that finished.
    pub fn close(&mut self) -> Vec<TurnEvent> {
        let mut events = Vec::new();
        let last = self.frame as f64 * self.spf;
        for speaker in 0..self.open.len() {
            let Some(mut run) = self.open[speaker] else {
                continue;
            };
            let end = match run.end {
                Some(end) => last.min(self.end_of(end)),
                None => last,
            };
            self.confirm(&mut run, speaker, end, &mut events);
            if run.confirmed {
                events.push(TurnEvent {
                    speaker,
                    seconds: end,
                    starting: false,
                });
            }
            self.open[speaker] = None;
        }
        self.raw.iter_mut().for_each(|r| *r = false);
        events
    }
}

/// The runtime's batch postprocessing (`diar_segments_from_probs`), as Ownkey's test ports it:
/// the reference the causal events must equal. `(start, end, speaker)`, rounded to 1 µs, sorted.
#[cfg(test)]
pub(crate) fn offline_segments(
    probs: &[f32],
    speakers: usize,
    spf: f64,
    p: &BinarizerParams,
) -> Vec<(f64, f64, usize)> {
    let frames = probs.len() / speakers;
    let total = frames as f64 * spf;
    let mut out = Vec::new();
    for s in 0..speakers {
        let mut segs: Vec<[f64; 2]> = Vec::new();
        let (mut active, mut start) = (false, 0usize);
        for f in 0..frames {
            let v = probs[f * speakers + s];
            if !active && v > p.onset {
                active = true;
                start = f;
            } else if active && v < p.offset {
                active = false;
                segs.push([
                    (start as f64 * spf - p.pad_onset).max(0.0),
                    total.min(f as f64 * spf + p.pad_offset),
                ]);
            }
        }
        if active {
            segs.push([(start as f64 * spf - p.pad_onset).max(0.0), total]);
        }
        let mut merged: Vec<[f64; 2]> = Vec::new();
        for seg in segs {
            match merged.last_mut() {
                Some(last) if seg[0] - last[1] < p.min_off => last[1] = last[1].max(seg[1]),
                _ => merged.push(seg),
            }
        }
        out.extend(
            merged
                .into_iter()
                .filter(|[a, b]| b - a >= p.min_on)
                .map(|[a, b]| (round6(a), round6(b), s)),
        );
    }
    sort_segments(&mut out);
    out
}

#[cfg(test)]
fn round6(x: f64) -> f64 {
    (x * 1e6).round() / 1e6
}

#[cfg(test)]
fn sort_segments(out: &mut [(f64, f64, usize)]) {
    out.sort_by(|a, b| {
        a.0.total_cmp(&b.0)
            .then(a.1.total_cmp(&b.1))
            .then(a.2.cmp(&b.2))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ownkey's test generator: PCG32 (O'Neill's `pcg32_random_r`), seeded, no new crate.
    struct Pcg32 {
        state: u64,
        inc: u64,
    }

    impl Pcg32 {
        fn new(seed: u64) -> Pcg32 {
            let mut rng = Pcg32 {
                state: 0,
                inc: (54 << 1) | 1,
            };
            rng.next();
            rng.state = rng.state.wrapping_add(seed);
            rng.next();
            rng
        }

        fn next(&mut self) -> u32 {
            let old = self.state;
            self.state = old
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(self.inc);
            let shifted = (((old >> 18) ^ old) >> 27) as u32;
            let rot = (old >> 59) as u32;
            shifted.rotate_right(rot)
        }

        /// In `lo..hi`.
        fn int(&mut self, lo: u64, hi: u64) -> u64 {
            lo + u64::from(self.next()) % (hi - lo)
        }

        fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
            lo + (hi - lo) * (f64::from(self.next()) / f64::from(u32::MAX))
        }

        fn choice(&mut self, list: &[u64]) -> u64 {
            list[self.int(0, list.len() as u64) as usize]
        }
    }

    /// Bursts, short gaps, blips and overlaps on a 10 ms grid: the shape of Ownkey's `speech()`
    /// (`tests/test_meetings_diarization.py:126-136`).
    fn speech(frames: usize, speakers: usize, rng: &mut Pcg32) -> Vec<f32> {
        let mut probs = vec![0f32; frames * speakers];
        for s in 0..speakers {
            let mut f = rng.int(0, 80) as usize;
            while f < frames {
                let length = rng.choice(&[2, 8, 25, 60, 150]) as usize;
                let level = rng.uniform(0.62, 1.0) as f32;
                for frame in f..(f + length).min(frames) {
                    probs[frame * speakers + s] = level;
                }
                f += length + rng.choice(&[1, 5, 20, 35, 120]) as usize;
            }
        }
        for p in &mut probs {
            *p = (*p + rng.uniform(-0.08, 0.08) as f32).clamp(0.0, 1.0);
        }
        probs
    }

    /// Pairs the events into `(start, end, speaker)` segments, as Ownkey's `causal_segments`.
    fn causal_segments(events: &[TurnEvent]) -> Vec<(f64, f64, usize)> {
        let mut open = std::collections::HashMap::new();
        let mut out = Vec::new();
        for e in events {
            if e.starting {
                assert!(
                    open.insert(e.speaker, e.seconds).is_none(),
                    "a speaker started twice"
                );
            } else {
                let start = open.remove(&e.speaker).expect("an end has a start");
                out.push((round6(start), round6(e.seconds), e.speaker));
            }
        }
        assert!(open.is_empty(), "every start has an end");
        sort_segments(&mut out);
        out
    }

    #[test]
    fn causal_events_match_the_runtime_postprocessing() {
        let mut rng = Pcg32::new(7);
        let p = BinarizerParams::default();
        for trial in 0..30 {
            let frames = rng.int(50, 900) as usize;
            let probs = speech(frames, 3, &mut rng);
            let mut b = LiveBinarizer::new(3, 0.01, p);
            let mut events = Vec::new();
            // Model chunks arrive in irregular slices.
            for slice in probs.chunks(13 * 3) {
                events.extend(b.feed(slice));
            }
            events.extend(b.close());
            assert_eq!(
                causal_segments(&events),
                offline_segments(&probs, 3, 0.01, &p),
                "trial {trial}"
            );
        }
    }

    #[test]
    fn no_event_arrives_for_time_that_was_already_settled() {
        let mut rng = Pcg32::new(11);
        for trial in 0..30 {
            let frames = rng.int(50, 900) as usize;
            let probs = speech(frames, 3, &mut rng);
            let mut b = LiveBinarizer::new(3, 0.01, BinarizerParams::default());
            let mut settled = 0.0;
            let mut first = 0;
            while first < frames {
                let step = rng.int(1, 40) as usize;
                let to = (first + step).min(frames);
                for e in b.feed(&probs[first * 3..to * 3]) {
                    assert!(e.seconds >= settled - 1e-9, "trial {trial}: {e:?}");
                }
                assert!(
                    b.settled_seconds() >= settled - 1e-9,
                    "trial {trial}: the horizon never moves back"
                );
                settled = b.settled_seconds();
                first = to;
            }
        }
    }

    #[test]
    fn a_blip_is_ignored_and_a_short_gap_is_filled() {
        let mut probs = vec![0f32; 300];
        // 50 ms: shorter than the minimum duration even with padding.
        probs[10..15].fill(0.9);
        probs[100..160].fill(0.9);
        // A 100 ms gap: filled.
        probs[170..230].fill(0.9);
        let mut b = LiveBinarizer::new(1, 0.01, BinarizerParams::default());
        let mut events = b.feed(&probs);
        events.extend(b.close());
        let found: Vec<(usize, f64, bool)> = events
            .iter()
            .map(|e| (e.speaker, (e.seconds * 1000.0).round() / 1000.0, e.starting))
            .collect();
        assert_eq!(found, vec![(0, 0.771, true), (0, 2.379, false)]);
    }

    #[test]
    fn a_start_is_reported_before_the_speaker_stops() {
        let mut probs = vec![0f32; 100];
        probs[20..].fill(0.9);
        let events = LiveBinarizer::new(1, 0.01, BinarizerParams::default()).feed(&probs);
        assert_eq!(events.len(), 1);
        assert!(events[0].starting);
    }

    #[test]
    fn settled_trails_the_frames_by_the_look_back() {
        let mut b = LiveBinarizer::new(2, 0.01, BinarizerParams::default());
        assert_eq!(b.settled_seconds(), 0.0);
        b.feed(&[0.0; 200]);
        // 100 frames at 10 ms, less max(0.511, 0.229 + 0.296).
        assert!((b.settled_seconds() - (1.0 - 0.525)).abs() < 1e-9);
        // A blip that may still merge with later speech holds the horizon at its padded start
        // until its gap closes.
        let mut frames = vec![0.0f32; 60 * 2];
        for f in 0..5 {
            frames[f * 2 + 1] = 0.9;
        }
        b.feed(&frames);
        assert!((b.settled_seconds() - (1.0 - 0.229)).abs() < 1e-9);
        b.feed(&[0.0; 40 * 2]);
        assert!((b.settled_seconds() - (2.0 - 0.525)).abs() < 1e-9);
    }

    /// Ownkey's own events for synthetic timelines, written by voice/scripts/binarizer-vectors.py.
    #[test]
    fn the_events_equal_ownkeys_for_the_shared_vectors() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/binarizer-vectors.json"
        );
        let text = std::fs::read_to_string(path).expect("voice/fixtures/binarizer-vectors.json");
        let vectors: serde_json::Value = serde_json::from_str(&text).unwrap();
        let cases = vectors["cases"].as_array().unwrap();
        assert!(cases.len() >= 5);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let speakers = case["speakers"].as_u64().unwrap() as usize;
            let spf = case["secondsPerFrame"].as_f64().unwrap();
            let probs: Vec<f32> = case["probs"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|row| row.as_array().unwrap())
                .map(|v| v.as_f64().unwrap() as f32)
                .collect();
            let slices: Vec<usize> = case["slices"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as usize)
                .collect();
            let expected: Vec<(usize, f64, bool)> = case["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| {
                    (
                        e[0].as_u64().unwrap() as usize,
                        e[1].as_f64().unwrap(),
                        e[2].as_bool().unwrap(),
                    )
                })
                .collect();
            let mut b = LiveBinarizer::new(speakers, spf, BinarizerParams::default());
            let mut events = Vec::new();
            let mut first = 0;
            for n in slices {
                events.extend(b.feed(&probs[first * speakers..(first + n) * speakers]));
                first += n;
            }
            assert_eq!(first * speakers, probs.len(), "{name}: the slices cover it");
            events.extend(b.close());
            assert_eq!(events.len(), expected.len(), "{name}");
            for (got, want) in events.iter().zip(&expected) {
                assert_eq!((got.speaker, got.starting), (want.0, want.2), "{name}");
                assert!(
                    (got.seconds - want.1).abs() < 1e-6,
                    "{name}: {got:?} against {want:?}"
                );
            }
        }
    }
}
