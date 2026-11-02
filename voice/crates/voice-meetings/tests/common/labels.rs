//! Speaker label helpers: calls whose voices are told apart by their loudness, a diarizer that
//! needs no model, and Mistral's realtime stream without a network.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use voice_core::providers::stream::{SpeechStream, StreamEvent, StreamSession, StreamingSpeech};
use voice_core::speakers::{DiarError, DiarErrorKind, DiarStream, Diarizer, Probs, StreamGeometry};
use voice_core::{ErrorKind, ProviderError};

use super::RATE;

/// Samples per diarizer frame: 10 ms.
pub const FRAME: usize = 160;
/// Below this a frame holds no voice. Recorded quiet is ±50, so pushed padding (exact zeros) can
/// be told from recorded silence.
pub const VOICE_FLOOR: u16 = 1000;
pub const QUIET: i16 = 50;
pub const SCRIPTED_SPEAKERS: usize = 8;

/// The amplitude of hidden speaker `k`'s voice: 2000, 3000, 4000, ...
pub fn amplitude(k: usize) -> i16 {
    2000 + 1000 * k as i16
}

/// The hidden speaker in a stretch of audio: the loudest sample tells the amplitude.
pub fn hidden_speaker(pcm: &[i16]) -> Option<usize> {
    let loudest = pcm.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
    (loudest >= VOICE_FLOOR).then(|| (loudest as usize).saturating_sub(1500) / 1000)
}

/// A call made of `(seconds, speaker)` pieces: speaker `k` is a 296 Hz square wave of
/// [`amplitude`]`(k)`, `None` is quiet at ±50.
pub fn voices(pieces: &[(f64, Option<usize>)]) -> Vec<i16> {
    let mut out = Vec::new();
    for &(seconds, speaker) in pieces {
        let n = (seconds * RATE as f64).round() as usize;
        let level = speaker.map_or(QUIET, amplitude);
        out.extend((0..n).map(|i| if (i / 27) % 2 == 0 { level } else { -level }));
    }
    out
}

/// Who speaks when in a call made by [`voices`]: `(start ms, end ms, speaker)`, `offset` ms on.
pub fn timeline_of(pieces: &[(f64, Option<usize>)], offset: u64) -> Vec<(u64, u64, usize)> {
    let mut out = Vec::new();
    let mut at = offset as f64;
    for &(seconds, speaker) in pieces {
        let end = at + seconds * 1000.0;
        if let Some(k) = speaker {
            out.push((at.round() as u64, end.round() as u64, k));
        }
        at = end;
    }
    out
}

/// The hidden speaker who talks most inside `[start, end)` ms.
pub fn who(timeline: &[(u64, u64, usize)], start: u64, end: u64) -> Option<usize> {
    let mut best: Option<(u64, usize)> = None;
    for &(a, b, k) in timeline {
        let shared = b.min(end).saturating_sub(a.max(start));
        if shared > 0 && best.is_none_or(|(s, _)| shared > s) {
            best = Some((shared, k));
        }
    }
    best.map(|(_, k)| k)
}

/// What a [`ScriptedDiarizer`] does and saw. Push numbers count from 1 over every stream.
#[derive(Default)]
pub struct Script {
    pub opens: usize,
    pub pushes: usize,
    pub pushed_samples: u64,
    /// Samples pushed that were exact zeros: the follower's padding.
    pub zero_samples: u64,
    pub finishes: usize,
    /// Pushes that crash the worker.
    pub crash_on: Vec<usize>,
    /// Every push crashes from now on.
    pub crash_all: bool,
    /// Pushes that hang for `hang`, then time out.
    pub hang_on: Vec<usize>,
    pub hang: Duration,
    /// `open` refuses with this kind.
    pub refuse: Option<DiarErrorKind>,
    /// Frames are committed this many frames after they were pushed, as model chunks are.
    pub lag_frames: usize,
}

/// A diarizer that needs no model: it hears each frame's hidden speaker from its loudness,
/// numbers the voices of each stream in the order it hears them, and shifts those numbers by
/// three per stream, so every new stream calls the same voices something else.
#[derive(Clone, Default)]
pub struct ScriptedDiarizer {
    pub script: Arc<Mutex<Script>>,
}

impl ScriptedDiarizer {
    pub fn new() -> ScriptedDiarizer {
        ScriptedDiarizer::default()
    }

    pub fn with(f: impl FnOnce(&mut Script)) -> ScriptedDiarizer {
        let d = ScriptedDiarizer::default();
        f(&mut d.script());
        d
    }

    pub fn script(&self) -> MutexGuard<'_, Script> {
        self.script.lock().unwrap()
    }
}

impl Diarizer for ScriptedDiarizer {
    fn open(&self) -> Result<Box<dyn DiarStream>, DiarError> {
        let mut script = self.script();
        if let Some(kind) = script.refuse {
            return Err(DiarError::new(kind, "The scripted runtime refused."));
        }
        let number = script.opens;
        script.opens += 1;
        Ok(Box::new(ScriptedStream {
            script: self.script.clone(),
            number,
            labels: HashMap::new(),
            buffer: Vec::new(),
            frames: Vec::new(),
            committed: 0,
            finished: false,
        }))
    }
}

struct ScriptedStream {
    script: Arc<Mutex<Script>>,
    number: usize,
    labels: HashMap<usize, usize>,
    buffer: Vec<i16>,
    /// The label of every frame so far, `None` for silence.
    frames: Vec<Option<usize>>,
    committed: usize,
    finished: bool,
}

impl ScriptedStream {
    fn label(&mut self, hidden: usize) -> usize {
        let next = self.labels.len();
        let shift = self.number * 3;
        *self
            .labels
            .entry(hidden)
            .or_insert((next + shift) % SCRIPTED_SPEAKERS)
    }

    fn take_frames(&mut self) {
        while self.buffer.len() >= FRAME {
            let frame: Vec<i16> = self.buffer.drain(..FRAME).collect();
            let label = hidden_speaker(&frame).map(|k| self.label(k));
            self.frames.push(label);
        }
    }

    fn commit(&mut self, upto: usize) -> Probs {
        let first = self.committed;
        let upto = upto.max(first);
        let mut values = Vec::with_capacity((upto - first) * SCRIPTED_SPEAKERS);
        for f in first..upto {
            for s in 0..SCRIPTED_SPEAKERS {
                values.push(if self.frames[f] == Some(s) {
                    0.95
                } else {
                    0.02
                });
            }
        }
        self.committed = upto;
        Probs {
            first_frame: first as u64,
            frames: upto - first,
            speakers: SCRIPTED_SPEAKERS,
            values,
        }
    }
}

impl DiarStream for ScriptedStream {
    fn geometry(&self) -> StreamGeometry {
        StreamGeometry {
            speakers: SCRIPTED_SPEAKERS,
            seconds_per_frame: 0.01,
        }
    }

    fn push(&mut self, pcm: &[i16]) -> Result<Probs, DiarError> {
        assert!(!self.finished, "a push after finish");
        let (crash, hang, lag) = {
            let mut s = self.script.lock().unwrap();
            s.pushes += 1;
            s.pushed_samples += pcm.len() as u64;
            if pcm.iter().all(|&x| x == 0) {
                s.zero_samples += pcm.len() as u64;
            }
            let n = s.pushes;
            let hang = s.hang_on.contains(&n).then_some(s.hang);
            (s.crash_all || s.crash_on.contains(&n), hang, s.lag_frames)
        };
        if crash {
            return Err(DiarError::new(
                DiarErrorKind::Crashed,
                "The scripted worker crashed.",
            ));
        }
        if let Some(hang) = hang {
            std::thread::sleep(hang);
            return Err(DiarError::new(
                DiarErrorKind::Timeout,
                "The scripted worker stopped answering.",
            ));
        }
        self.buffer.extend_from_slice(pcm);
        self.take_frames();
        let upto = self.frames.len().saturating_sub(lag);
        Ok(self.commit(upto))
    }

    fn finish(&mut self) -> Result<Probs, DiarError> {
        self.finished = true;
        self.script.lock().unwrap().finishes += 1;
        if !self.buffer.is_empty() {
            let rest = std::mem::take(&mut self.buffer);
            let label = hidden_speaker(&rest).map(|k| self.label(k));
            self.frames.push(label);
        }
        Ok(self.commit(self.frames.len()))
    }

    fn worker_pid(&self) -> Option<u32> {
        Some(40_000 + self.number as u32)
    }
}

/// What a [`FakeStreaming`] did and saw.
#[derive(Default)]
pub struct FakeStreamState {
    pub sessions: Vec<StreamSession>,
    pub pushes: usize,
    /// Pushes of sessions that label voices, counted from 1 over those sessions.
    pub labelled_pushes: usize,
    /// Those pushes that drop the connection.
    pub fail_on: Vec<usize>,
    /// This many `end` calls of sessions that label voices drop the connection first.
    pub fail_ends: usize,
    /// Segments carry `start` and `end`.
    pub timed: bool,
}

/// Mistral's realtime stream without a network: one segment per burst of a hidden speaker, sent
/// when the burst ends. With `diarize`, a segment names its voice `s<session>-<n>`, or after a
/// reference that holds that voice; without, segments are text deltas with their own spacing.
#[derive(Clone, Default)]
pub struct FakeStreaming {
    pub state: Arc<Mutex<FakeStreamState>>,
}

impl FakeStreaming {
    pub fn state(&self) -> MutexGuard<'_, FakeStreamState> {
        self.state.lock().unwrap()
    }
}

impl StreamingSpeech for FakeStreaming {
    fn connect(&self, session: &StreamSession) -> Result<Box<dyn SpeechStream>, ProviderError> {
        let mut state = self.state();
        state.sessions.push(session.clone());
        let mut names = HashMap::new();
        for (name, wav) in &session.references {
            assert_eq!(&wav[..4], b"RIFF", "a reference is a WAV");
            let pcm: Vec<i16> = wav[44..]
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]))
                .collect();
            if let Some(k) = hidden_speaker(&pcm) {
                names.insert(k, name.clone());
            }
        }
        Ok(Box::new(FakeStream {
            state: self.state.clone(),
            number: state.sessions.len(),
            diarize: session.diarize,
            timed: state.timed,
            names,
            heard: 0,
            position: 0,
            burst: None,
            events: Vec::new(),
        }))
    }
}

struct FakeStream {
    state: Arc<Mutex<FakeStreamState>>,
    number: usize,
    diarize: bool,
    timed: bool,
    names: HashMap<usize, String>,
    heard: usize,
    /// Stream samples so far.
    position: u64,
    /// The burst going on: hidden speaker and its first stream sample.
    burst: Option<(usize, u64)>,
    events: Vec<StreamEvent>,
}

impl FakeStream {
    fn end_burst(&mut self) {
        let Some((k, start)) = self.burst.take() else {
            return;
        };
        let speaker = if self.diarize {
            if !self.names.contains_key(&k) {
                self.heard += 1;
                let name = format!("s{}-{}", self.number, self.heard);
                self.names.insert(k, name);
            }
            Some(self.names[&k].clone())
        } else {
            None
        };
        let seconds = |s: u64| s as f64 / RATE as f64;
        // A word per 350 ms, so a segment without times gets about the burst's length.
        let words = ((self.position - start) / (RATE as u64 * 350 / 1000)).max(1);
        let word = format!("w{}", start / 16);
        let text = vec![word; words as usize].join(" ");
        self.events.push(StreamEvent::Segment {
            text: if self.diarize {
                text
            } else {
                format!(" {text}")
            },
            speaker,
            start: self.timed.then(|| seconds(start)),
            end: self.timed.then(|| seconds(self.position)),
        });
    }
}

impl SpeechStream for FakeStream {
    fn push(&mut self, pcm: &[i16]) -> Result<(), ProviderError> {
        {
            let mut state = self.state.lock().unwrap();
            state.pushes += 1;
            if self.diarize {
                state.labelled_pushes += 1;
            }
            if self.diarize && state.fail_on.contains(&state.labelled_pushes) {
                return Err(ProviderError::new(
                    ErrorKind::Network,
                    "The fake stream dropped the connection.",
                ));
            }
        }
        for frame in pcm.chunks(FRAME) {
            match (self.burst, hidden_speaker(frame)) {
                (Some((now, _)), Some(k)) if now == k => {}
                (_, Some(k)) => {
                    self.end_burst();
                    self.burst = Some((k, self.position));
                }
                (Some(_), None) => self.end_burst(),
                (None, None) => {}
            }
            self.position += frame.len() as u64;
        }
        Ok(())
    }

    fn poll(&mut self, _wait: Duration) -> Result<Vec<StreamEvent>, ProviderError> {
        Ok(std::mem::take(&mut self.events))
    }

    fn end(&mut self) -> Result<(), ProviderError> {
        {
            let mut state = self.state.lock().unwrap();
            if self.diarize && state.fail_ends > 0 {
                state.fail_ends -= 1;
                return Err(ProviderError::new(
                    ErrorKind::Network,
                    "The fake stream dropped the connection while it finished.",
                ));
            }
        }
        self.end_burst();
        self.events.push(StreamEvent::Done);
        Ok(())
    }
}
