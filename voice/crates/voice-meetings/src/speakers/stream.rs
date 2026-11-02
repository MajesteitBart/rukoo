//! The stream follower: one thread per track of a meeting that Mistral's realtime model
//! transcribes, and on the call labels.
//!
//! It streams the recorded track to the provider in 100 ms pieces, never faster than twice real
//! time, and only while the meeting's consent check allows it. What comes back is stored in
//! `transcript.db` as segments in meeting time, with how far the stream has answered; the
//! pipeline builds passages from them and makes no network call itself. Mistral's realtime
//! segments may come without times, so Voice estimates them from when they arrived.
//!
//! After a dropped connection a new session starts after the last answer the old one sent, and on
//! the call it first gets a clip of every voice heard so far, named after its `call-N` id, so
//! Mistral gives those voices the same names again. Mistral never falls back to Nemotron.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use voice_core::providers::stream::{SpeechStream, StreamEvent, StreamSession};
use voice_core::providers::wav_bytes;
use voice_core::{ErrorKind, ProviderError};
use voice_protocol::{MeetingState, Track};

use crate::library::MeetingDir;
use crate::pipeline::{has_open_segment, read_track, track_horizon, ConsentCheck, DRIFT_GAP};
use crate::reader::{TrackReader, PER_MS};
use crate::speakers::clock::StreamClock;
use crate::speakers::follower::{FollowerHandle, FollowerShared, FollowerTiming};
use crate::speakers::{LabelState, StreamOptions};
use crate::transcript::{answered_key, call_number, LabelBatch, MapRow, StoredSegment, Transcript};
use crate::watcher::TimelineWatcher;

/// The answers for the last 0.5 s before the delay may still change.
const ANSWER_MARGIN_MS: u64 = 500;
/// A segment without times lasts 350 ms per word, between 0.3 s and 6 s.
const MS_PER_WORD: u64 = 350;
const MIN_GUESS_MS: u64 = 300;
const MAX_GUESS_MS: u64 = 6_000;
/// References: at most eight voices, each the longest of its passages of at least 3 s, cut to
/// 15 s.
const REFERENCES: usize = 8;
const REFERENCE_MIN_MS: u64 = 3_000;
const REFERENCE_MAX_MS: u64 = 15_000;
/// A voice's stored segments this close together make one stretch for its reference, as words
/// this close together make one passage.
const REFERENCE_JOIN_MS: u64 = 900;
/// A new session sends again at most this much of what the old one sent past its last answer.
/// Silence gets no answer, so a muted microphone would otherwise be streamed again from the
/// meeting's start, at twice real time at most; a provider that answered nothing for five
/// minutes of speech is broken rather than behind. An answer without times counts up to where
/// it was estimated to end, so audio a late provider hadn't answered for yet, a second or two
/// at its configured delay, can still be lost when the connection drops right then.
const REPLAY_MAX_MS: u64 = 300_000;
/// A session that took this much audio without an error counts as working, for the retry wait.
const HEALTHY_SAMPLES: u64 = 30 * 16_000;

/// Starts stream followers.
pub(crate) struct StreamFollower;

impl StreamFollower {
    /// Streams `track` of `dir` until the recording stopped and the provider answered for all of
    /// it. After the stop, `give_up_after` failures in a row end it as failed. `shared` comes
    /// from [`FollowerShared::new`], so the pipeline can hold on to it before the thread runs.
    pub(crate) fn start(
        dir: MeetingDir,
        track: Track,
        opts: StreamOptions,
        allowed: ConsentCheck,
        timing: FollowerTiming,
        give_up_after: u32,
        shared: Arc<FollowerShared>,
    ) -> FollowerHandle {
        let name = format!("stream-{}-{}", track.as_str(), dir.id());
        FollowerHandle::spawn(name, shared, move |shared| {
            let Some(transcript) = open(&dir, &shared, &timing) else {
                return;
            };
            let answered = transcript
                .meta_u64(&answered_key(track))
                .ok()
                .flatten()
                .unwrap_or(0);
            let confirmed = transcript.segments_end(track).ok().flatten().unwrap_or(0);
            shared.set_settled(answered);
            let mut ctx = Ctx {
                watcher: TimelineWatcher::new(dir.path()),
                dir,
                track,
                opts,
                allowed,
                timing,
                give_up_after,
                shared,
                transcript,
                lengths: HashMap::new(),
                answered,
                confirmed,
                progressed: false,
                fed: 0,
                session: None,
            };
            ctx.fed = ctx.resume_ms() * PER_MS;
            ctx.run();
        })
    }
}

fn open(dir: &MeetingDir, shared: &FollowerShared, timing: &FollowerTiming) -> Option<Transcript> {
    loop {
        if shared.stopping() || !dir.path().is_dir() {
            return None;
        }
        match Transcript::open(dir.path()) {
            Ok(t) => return Some(t),
            Err(e) => {
                shared.note_error(format!("the transcript store failed: {e}"));
                shared.sleep(timing.poll * 10);
            }
        }
    }
}

struct Session {
    stream: Box<dyn SpeechStream>,
    epoch: u64,
    clock: StreamClock,
    /// The next segment's number.
    n: u64,
    /// Stream samples where the last segment ended.
    prev_end: u64,
    started: Instant,
    done: bool,
    /// The ids sent as references; the provider names those voices after them.
    references: Vec<String>,
}

/// Why a step failed.
enum Fail {
    Provider(ProviderError),
    Store(String),
}

impl From<ProviderError> for Fail {
    fn from(e: ProviderError) -> Fail {
        Fail::Provider(e)
    }
}

impl From<rusqlite::Error> for Fail {
    fn from(e: rusqlite::Error) -> Fail {
        Fail::Store(format!("the transcript store failed: {e}"))
    }
}

impl From<std::io::Error> for Fail {
    fn from(e: std::io::Error) -> Fail {
        Fail::Store(format!("the meeting folder can't be read: {e}"))
    }
}

enum Flow {
    /// Sent or stored something; look again at once.
    Busy,
    /// Nothing to do now.
    Idle,
    /// The provider answered for the whole track.
    Finished,
}

struct Ctx {
    dir: MeetingDir,
    track: Track,
    opts: StreamOptions,
    allowed: ConsentCheck,
    timing: FollowerTiming,
    give_up_after: u32,
    shared: Arc<FollowerShared>,
    transcript: Transcript,
    watcher: TimelineWatcher,
    lengths: HashMap<(String, u64), u64>,
    /// Meeting ms up to which the provider answered, estimated from what was sent: the pipeline
    /// cuts windows up to here.
    answered: u64,
    /// Meeting ms up to which the provider demonstrably answered: the end of the last segment it
    /// sent, or everything it was sent once it finished.
    confirmed: u64,
    /// The provider sent something since the last look: a segment or the end of the stream.
    progressed: bool,
    /// Meeting samples sent in this session.
    fed: u64,
    session: Option<Session>,
}

impl Ctx {
    fn run(&mut self) {
        let mut attempts = 0u32;
        let mut after_stop = 0u32;
        let mut retry_at: Option<Instant> = None;
        loop {
            if self.shared.stopping() || !self.dir.path().is_dir() {
                return;
            }
            if let Err(e) = self.watcher.poll() {
                self.shared
                    .note_error(format!("the timeline can't be read: {e}"));
                self.shared.sleep(self.timing.poll);
                continue;
            }
            if (self.allowed)().is_err() {
                // No audio leaves before the user agreed, and none after they took it back.
                self.drop_session();
                self.shared.update(|s| s.reason = Some("consent".into()));
                self.shared.set_state(LabelState::Starting);
                self.shared.sleep(self.timing.poll);
                continue;
            }
            self.shared.update(|s| {
                if s.reason.as_deref() == Some("consent") {
                    s.reason = None;
                }
            });
            if retry_at.is_some_and(|t| Instant::now() < t) {
                self.shared.sleep(self.timing.poll);
                continue;
            }
            let stopped = self.watcher.mapper().stop().is_some();
            match self.step() {
                Ok(Flow::Finished) => {
                    self.session = None;
                    self.shared.set_state(LabelState::Finished);
                    return;
                }
                Ok(flow) => {
                    // Only answers count as progress after the stop: a provider that takes the
                    // connection and then fails the first audio still runs out of tries.
                    if std::mem::take(&mut self.progressed) {
                        attempts = 0;
                        after_stop = 0;
                    } else if self
                        .session
                        .as_ref()
                        .is_some_and(|s| s.clock.sent() >= HEALTHY_SAMPLES)
                    {
                        attempts = 0;
                    }
                    retry_at = None;
                    if matches!(flow, Flow::Idle) {
                        self.shared.sleep(self.timing.poll);
                    }
                }
                // A follower that was replaced leaves the store to the new one.
                Err(_) if self.shared.stopping() => return,
                Err(fail) => {
                    self.drop_session();
                    let message = match fail {
                        Fail::Provider(e) if e.message.trim().is_empty() => {
                            "The streaming transcription failed.".to_owned()
                        }
                        Fail::Provider(e) => e.message,
                        Fail::Store(m) => m,
                    };
                    eprintln!(
                        "voice-meetings: {}: the {} stream stopped: {message}",
                        self.dir.id(),
                        self.track.as_str()
                    );
                    attempts += 1;
                    if stopped {
                        after_stop += 1;
                        if after_stop >= self.give_up_after {
                            self.shared.fail("stream", message);
                            return;
                        }
                    }
                    self.shared.note_error(message);
                    self.shared.set_state(LabelState::Restarting);
                    let doublings = attempts.saturating_sub(1).min(16);
                    let wait = self
                        .timing
                        .stream_retry_first
                        .saturating_mul(1 << doublings)
                        .min(self.timing.stream_retry_max);
                    retry_at = Some(Instant::now() + wait);
                }
            }
        }
    }

    /// Closes the session. What it sent past its last answer is sent again by the next one, so
    /// a session that drops while the provider is behind, or after the last audio went out while
    /// it finishes, doesn't leave that audio without answers.
    fn drop_session(&mut self) {
        self.session = None;
        self.fed = self.resume_ms() * PER_MS;
    }

    /// Where the next session starts: after the provider's last answer, at most
    /// [`REPLAY_MAX_MS`] before the estimated position, and never after it.
    fn resume_ms(&self) -> u64 {
        self.answered.min(
            self.confirmed
                .max(self.answered.saturating_sub(REPLAY_MAX_MS)),
        )
    }

    fn reader(&mut self) -> TrackReader {
        read_track(
            self.dir.path(),
            self.track,
            self.watcher.mapper(),
            &mut self.lengths,
        )
    }

    fn step(&mut self) -> Result<Flow, Fail> {
        let reader = self.reader();
        let mapper = self.watcher.mapper();
        let stopped = mapper.stop().is_some();
        let paused = mapper.state() == Some(MeetingState::Paused);
        let open = has_open_segment(mapper, self.track);
        let horizon = track_horizon(mapper, self.track, &reader, stopped);

        if self.session.is_none() {
            let waiting = reader.covered(self.fed) || reader.next_audio(self.fed).is_some();
            if !waiting {
                return Ok(if stopped && self.fed >= reader.end() {
                    Flow::Finished
                } else {
                    Flow::Idle
                });
            }
            self.connect(&reader)?;
            return Ok(Flow::Busy);
        }

        if reader.covered(self.fed) {
            let span_end = reader.span_end(self.fed, 0).unwrap_or(self.fed);
            let chunk = self.timing.stream_chunk.max(1);
            let len = (span_end - self.fed).min(chunk);
            let span_closed = stopped || !open || reader.next_audio(span_end).is_some();
            let session = self.session.as_ref().expect("connected");
            let allowed = session.started.elapsed().as_secs_f64()
                * 16_000.0
                * self.timing.stream_speed.max(0.01);
            let ahead = session.clock.sent() as f64 >= allowed;
            if ahead || (len < chunk && !(span_closed && self.fed + len == span_end)) {
                return self.answers(Duration::from_millis(20)).map(|_| Flow::Idle);
            }
            let pcm = reader.read(self.fed, self.fed + len)?;
            let session = self.session.as_mut().expect("connected");
            session.clock.append(self.fed, len);
            session.stream.push(&pcm)?;
            self.fed += len;
            self.answers(Duration::ZERO)?;
            return Ok(Flow::Busy);
        }

        match reader.next_audio(self.fed) {
            Some(next) => {
                if next - self.fed >= DRIFT_GAP {
                    self.flush()?;
                }
                self.fed = next;
                Ok(Flow::Busy)
            }
            None if stopped && self.fed >= reader.end() => self.drain(),
            None => {
                let settled_gap = (paused && !open) || self.fed + DRIFT_GAP <= horizon;
                if settled_gap && self.flush()? {
                    return Ok(Flow::Busy);
                }
                self.answers(Duration::from_millis(20))?;
                Ok(Flow::Idle)
            }
        }
    }

    /// Pushes zeros once at a gap, so the stream answers for the audio before it. True when it
    /// pushed.
    fn flush(&mut self) -> Result<bool, Fail> {
        let session = self.session.as_mut().expect("connected");
        if !session.clock.last_is_real() {
            return Ok(false);
        }
        let mut left = (u64::from(self.opts.delay_ms) + ANSWER_MARGIN_MS) * PER_MS;
        while left > 0 {
            let len = left.min(16_000);
            session.clock.pad(len);
            session.stream.push(&vec![0i16; len as usize])?;
            left -= len;
        }
        self.answers(Duration::ZERO)?;
        Ok(true)
    }

    /// Ends the session and waits for its last answers. Only the provider's end of the stream
    /// counts everything sent as answered, which [`Ctx::answers`] stores. A provider that is
    /// behind gets the wait again with every answer; one that answers nothing for that long
    /// failed: the next session sends what it didn't answer for again, and failures after the
    /// stop end as a failed meeting, which keeps its audio.
    fn drain(&mut self) -> Result<Flow, Fail> {
        self.shared.set_state(LabelState::CatchingUp);
        self.session.as_mut().expect("connected").stream.end()?;
        let mut until = Instant::now() + self.timing.stream_drain;
        let mut heard = self.session.as_ref().map_or(0, |s| s.n);
        while !self.session.as_ref().is_some_and(|s| s.done) {
            if self.shared.stopping() {
                return Ok(Flow::Idle);
            }
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(Fail::Provider(ProviderError::new(
                    ErrorKind::Timeout,
                    format!(
                        "The streaming transcription stopped answering for {} seconds before it finished.",
                        self.timing.stream_drain.as_secs_f64().ceil() as u64
                    ),
                )));
            }
            self.answers(left.min(Duration::from_millis(200)))?;
            let n = self.session.as_ref().map_or(heard, |s| s.n);
            if n > heard {
                heard = n;
                until = Instant::now() + self.timing.stream_drain;
            }
        }
        Ok(Flow::Finished)
    }

    /// Starts a session where the last one had answered.
    fn connect(&mut self, reader: &TrackReader) -> Result<(), Fail> {
        let previous = self
            .transcript
            .epochs()?
            .into_iter()
            .filter(|e| e.track == self.track)
            .map(|e| e.epoch)
            .max();
        let diarize = self.track == Track::Call && self.opts.diarize;
        let references = match previous {
            Some(_) if diarize => self.references(reader)?,
            _ => Vec::new(),
        };
        let names = references.iter().map(|(name, _)| name.clone()).collect();
        let session = StreamSession {
            diarize,
            language: self.opts.language.clone(),
            context_bias: self.opts.context_bias.clone(),
            delay_ms: self.opts.delay_ms,
            references,
        };
        let stream = self.opts.speech.connect(&session)?;
        // A follower that was replaced while it connected leaves the store to the new one.
        let Some(_writing) = self.shared.writing() else {
            return Ok(());
        };
        let resume = self.resume_ms();
        // What the last session sent past its last answer is sent again.
        if let Some(previous) = previous {
            self.transcript
                .drop_segments_from(self.track, previous, resume)?;
        }
        let reason = if previous.is_some() {
            "reconnect"
        } else {
            "start"
        };
        let number = self
            .transcript
            .open_epoch(self.track, "mistral", resume, reason)?;
        self.fed = resume * PER_MS;
        self.session = Some(Session {
            stream,
            epoch: number,
            clock: StreamClock::new(),
            n: 0,
            prev_end: 0,
            started: Instant::now(),
            done: false,
            references: names,
        });
        self.shared.update(|s| s.epoch = number);
        self.shared.set_state(LabelState::Listening);
        Ok(())
    }

    /// A clip of each voice heard so far, named after its id: the longest of its call passages,
    /// or of its stretches of stored segments, of at least 3 s, cut to 15 s. The most recently
    /// heard first, at most eight. The segments count because the pipeline cuts passages behind
    /// the stream: a voice the provider named just before a drop has its id but maybe no
    /// passage yet, and without a clip the next session would give it a second id.
    fn references(&self, reader: &TrackReader) -> Result<Vec<(String, Vec<u8>)>, Fail> {
        let mut spans: Vec<(String, u64, u64)> = Vec::new();
        for stored in self.transcript.passages()? {
            let p = stored.passage;
            let Some(speaker) = p.speaker.filter(|s| call_number(s).is_some()) else {
                continue;
            };
            if p.track == Track::Call {
                spans.push((speaker, p.start, p.end));
            }
        }
        let map = self.transcript.speaker_map()?;
        let mut run: Option<(String, u64, u64)> = None;
        for segment in self.transcript.segments(Track::Call, 0, u64::MAX)? {
            let id = segment
                .label
                .and_then(|label| map.get(&(segment.epoch, label)).cloned());
            match (&mut run, id) {
                (Some(r), Some(id)) if r.0 == id && segment.start <= r.2 + REFERENCE_JOIN_MS => {
                    r.2 = r.2.max(segment.end);
                }
                (_, id) => {
                    spans.extend(run.take());
                    run = id.map(|id| (id, segment.start, segment.end));
                }
            }
        }
        spans.extend(run);
        let mut best: HashMap<String, (u64, u64, u64)> = HashMap::new();
        for (speaker, start, end) in spans {
            let entry = best.entry(speaker).or_insert((0, 0, 0));
            entry.2 = entry.2.max(end);
            let length = end.saturating_sub(start);
            if length >= REFERENCE_MIN_MS && length > entry.1.saturating_sub(entry.0) {
                entry.0 = start;
                entry.1 = end;
            }
        }
        let mut voices: Vec<(String, (u64, u64, u64))> = best
            .into_iter()
            .filter(|(_, (start, end, _))| end > start)
            .collect();
        voices.sort_by(|a, b| b.1 .2.cmp(&a.1 .2).then(a.0.cmp(&b.0)));
        voices.truncate(REFERENCES);
        let mut references = Vec::new();
        for (id, (start, end, _)) in voices {
            let end = end.min(start + REFERENCE_MAX_MS);
            let pcm = reader.read(start * PER_MS, end * PER_MS)?;
            references.push((id, wav_bytes(&pcm, 16_000)));
        }
        Ok(references)
    }

    /// Stores what the provider returned so far, waiting at most `wait` for the first answer.
    fn answers(&mut self, wait: Duration) -> Result<(), Fail> {
        let session = self.session.as_mut().expect("connected");
        let events = session.stream.poll(wait)?;
        // A follower that was replaced while it waited leaves the store to the new one.
        let Some(_writing) = self.shared.writing() else {
            return Ok(());
        };
        let sent = session.clock.sent();
        let delay = u64::from(self.opts.delay_ms) * PER_MS;
        let labelled = self.track == Track::Call && self.opts.diarize;
        let map = if labelled {
            self.transcript.speaker_map()?
        } else {
            HashMap::new()
        };
        let mut next = if labelled {
            self.transcript.highest_speaker_number()? + 1
        } else {
            0
        };
        let mut batch = LabelBatch::default();
        let mut rows = Vec::new();
        for event in events {
            let (text, speaker, start, end) = match event {
                StreamEvent::Done => {
                    session.done = true;
                    continue;
                }
                StreamEvent::Segment {
                    text,
                    speaker,
                    start,
                    end,
                } => (text, speaker, start, end),
            };
            // A delta of only a space parts the words around it, and a passage's text is trimmed
            // once it is put together. A labelled segment of only spaces says nothing, and would
            // only give its voice an id.
            let label = if labelled { speaker } else { None };
            if text.is_empty() || (label.is_some() && text.trim().is_empty()) {
                continue;
            }
            let timed = match (start, end) {
                (Some(a), Some(b)) if a.is_finite() && b.is_finite() && b >= a && a >= 0.0 => {
                    Some(((a * 16_000.0) as u64, (b * 16_000.0).ceil() as u64))
                }
                _ => None,
            };
            let (a, b) = timed.unwrap_or_else(|| {
                let end = sent.saturating_sub(delay).max(session.prev_end);
                let words = text.split_whitespace().count() as u64;
                let guess = (words * MS_PER_WORD).clamp(MIN_GUESS_MS, MAX_GUESS_MS) * PER_MS;
                (session.prev_end.max(end.saturating_sub(guess)), end)
            });
            session.prev_end = session.prev_end.max(b);
            let clock = &session.clock;
            let start_ms = clock
                .at(a.min(sent), false)
                .or_else(|| clock.at(a.min(sent), true))
                .map(|m| m / PER_MS);
            let end_ms = clock
                .at(b.min(sent), true)
                .or_else(|| clock.at(b.min(sent), false))
                .map(|m| m.div_ceil(PER_MS));
            let (Some(start_ms), Some(end_ms)) = (start_ms, end_ms) else {
                continue;
            };
            if let Some(label) = &label {
                let key = (session.epoch, label.clone());
                let known = map.contains_key(&key)
                    || batch
                        .map
                        .iter()
                        .any(|m| m.epoch == session.epoch && &m.label == label);
                if !known {
                    // A name Voice sent as a reference is that voice's id already.
                    let (speaker, how) = if session.references.contains(label) {
                        (label.clone(), "matched")
                    } else {
                        let id = format!("call-{next}");
                        next += 1;
                        (id, "new")
                    };
                    batch.map.push(MapRow {
                        epoch: session.epoch,
                        label: label.clone(),
                        speaker,
                        how: how.into(),
                    });
                }
            }
            rows.push(StoredSegment {
                track: self.track,
                epoch: session.epoch,
                n: session.n,
                label,
                text,
                start: start_ms,
                end: end_ms.max(start_ms),
                timed: timed.is_some(),
            });
            session.n += 1;
        }
        let at = sent.saturating_sub(delay + ANSWER_MARGIN_MS * PER_MS);
        let answered = if session.done {
            session.clock.at(sent, true).map(|m| m.div_ceil(PER_MS))
        } else if at > 0 {
            session.clock.at(at, true).map(|m| m / PER_MS)
        } else {
            None
        };
        let answered = answered.unwrap_or(0).max(self.answered);
        let mut confirmed = self.confirmed;
        if session.done {
            confirmed = confirmed.max(answered);
        }
        if let Some(end) = rows.iter().map(|r| r.end).max() {
            confirmed = confirmed.max(end);
        }
        let progressed = session.done || !rows.is_empty();
        let epoch = session.epoch;
        if !batch.is_empty() || !rows.is_empty() || answered > self.answered {
            self.transcript
                .store_answers(&batch, self.track, epoch, &rows, answered)?;
        }
        // Only what was stored counts: after a failed write the next session starts where the
        // stored answers end, and hears this audio again.
        self.confirmed = confirmed;
        self.progressed |= progressed;
        self.answered = answered;
        if !batch.map.is_empty() {
            let voices: HashSet<String> = self.transcript.speaker_map()?.into_values().collect();
            let count = voices.len() as u32;
            self.shared.update(|s| s.speakers = count);
        }
        self.shared.set_settled(answered);
        Ok(())
    }
}
