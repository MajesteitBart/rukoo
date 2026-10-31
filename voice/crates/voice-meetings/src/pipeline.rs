//! Follows one meeting while it records and afterwards, until every recorded second is
//! transcribed, and sends every meeting event to the event log.
//!
//! The recorder writes the audio and the timeline; the pipeline only reads them. It can stop,
//! crash or wait for consent at any moment without costing audio: its progress lives in
//! `transcript.db`, and a pipeline started again later continues from there. Each event has a key
//! that `transcript.db` keeps once the event is in the log, and at start the keys are checked
//! against the log itself, so nothing is sent twice, even after a crash between the two writes.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use voice_bridge::{EventLog, LogError};
use voice_core::{Hints, LocalEngine, ProviderError, SpeechToText};
use voice_protocol::{events, MeetingState, MeetingStateChange, Passage, Speaker, Track};

use crate::library::{MeetingDir, MeetingFile};
use crate::reader::{segment_samples, TrackReader, PER_MS};
use crate::segmentation::{
    next_boundary, owned_tokens, timed_passages, window_passage, within, worth_recognizing, Draft,
    CORE_LIMIT, LEFT_CONTEXT, RATE, RIGHT_CONTEXT,
};
use crate::stt::{Heard, Recognizer, TimedSpeechToText};
use crate::transcript::{Outcome, StoredPassage, Transcript};
use crate::watcher::{mark_key, state_key, tracks_of, Derived, Stop, Stretch, TimelineWatcher};

/// A track without an open segment may still get a segment that starts this far before the
/// timeline's latest time: a padded loopback writes its `segment` line up to 0.5 s late.
const SETTLE_MS: u64 = 1_000;
/// While a track has no audio, the pipeline moves past the silence in steps of at least 5 s.
const GAP_STEP: u64 = 5 * RATE as u64;
/// Neighbouring segments this close count as one stretch of audio: drift correction leaves
/// gaps of about 0.1 s (voice/RECORDING.md). A lost device is retried every second, so a real
/// gap is longer.
const DRIFT_GAP: u64 = 300 * PER_MS;
/// Dictation comes first: recognition waits while the user dictates, up to two minutes, as in
/// Ownkey (`meetings/service.py:973-986`).
const DICTATION_YIELD_MS: u64 = 120_000;
/// How long [`PipelineHandle::shutdown`] waits for a recognition call to return.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(5);

/// The decision 10 consent check: `Err(reason)` keeps transcription waiting.
pub type ConsentCheck = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

/// How a pipeline transcribes.
#[derive(Clone)]
pub struct PipelineOptions {
    /// The meeting's recognizer.
    pub stt: Arc<dyn SpeechToText>,
    /// The same recognizer with word timings, when it has them, as Orukeet does. It is used
    /// instead of `stt`: windows get context on both sides and passages split at pauses.
    pub timed: Option<Arc<dyn TimedSpeechToText>>,
    pub hints: Hints,
    /// Decision 10: `Err(reason)` while audio may not go to the meeting's provider. Recording
    /// goes on; transcription waits, and [`PipelineState::Waiting`] says why.
    pub transcription_allowed: ConsentCheck,
    pub timing: Timing,
}

impl PipelineOptions {
    /// Transcribes with `stt`, always allowed, without hints.
    pub fn new(stt: Arc<dyn SpeechToText>) -> PipelineOptions {
        PipelineOptions {
            stt,
            timed: None,
            hints: Hints::default(),
            transcription_allowed: Arc::new(|| Ok(())),
            timing: Timing::default(),
        }
    }

    /// Transcribes on this computer with Orukeet, using its word timings.
    pub fn local(engine: LocalEngine) -> PipelineOptions {
        PipelineOptions {
            timed: Some(Arc::new(engine.clone())),
            ..PipelineOptions::new(Arc::new(engine))
        }
    }
}

impl fmt::Debug for PipelineOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PipelineOptions")
            .field("timed", &self.timed.is_some())
            .field("hints", &self.hints)
            .field("timing", &self.timing)
            .finish_non_exhaustive()
    }
}

/// How often the pipeline looks and how it retries. The defaults are Ownkey's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Timing {
    /// Between looks when nothing was ready.
    pub poll: Duration,
    /// Between looks right after a window.
    pub busy_poll: Duration,
    /// The first wait after a failed recognition; it doubles up to `retry_max`.
    pub retry_first: Duration,
    pub retry_max: Duration,
    /// After the recording ended, this many failed recognitions in a row make the meeting
    /// `failed`. While it records, the pipeline never gives up.
    pub attempts_after_stop: u32,
}

impl Default for Timing {
    fn default() -> Timing {
        Timing {
            poll: Duration::from_millis(150),
            busy_poll: Duration::from_millis(30),
            retry_first: Duration::from_secs(2),
            retry_max: Duration::from_secs(60),
            attempts_after_stop: 5,
        }
    }
}

/// What a pipeline is doing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PipelineState {
    Starting,
    /// Up to date with the recording, waiting for more audio.
    Listening,
    /// A recognition call is running.
    Transcribing,
    /// Transcription waits for consent (decision 10); recording goes on.
    Waiting {
        reason: String,
    },
    /// Recognition or the disk failed; the pipeline tries again.
    Retrying {
        error: String,
    },
    /// Every recorded second is transcribed.
    Done,
    /// The recording ended and recognition kept failing. The audio stays; a pipeline started
    /// again later tries once more.
    Failed {
        reason: String,
    },
    /// Shut down, or the meeting is gone.
    Stopped,
}

impl PipelineState {
    /// Whether the pipeline's thread has nothing more to do.
    pub fn is_final(&self) -> bool {
        matches!(
            self,
            PipelineState::Done | PipelineState::Failed { .. } | PipelineState::Stopped
        )
    }
}

/// Starts pipelines.
pub struct Pipeline;

impl Pipeline {
    /// Follows `dir` on a thread of its own until its timeline has `stop` and every recorded
    /// second is transcribed.
    ///
    /// Sends every meeting event to `log`: `meeting.started` (from meeting.json), the speakers
    /// (`mic` "You", `call-1` "Speaker 1"), `meeting.state` and `mark` from the timeline,
    /// `passage` as windows are transcribed, and finally `done` (or `failed`). Start it once the
    /// recorder runs; it never touches the recorder.
    pub fn start(dir: MeetingDir, log: EventLog, opts: PipelineOptions) -> PipelineHandle {
        let shared = Arc::new(Shared::default());
        let meeting = dir.id().to_string();
        let thread = {
            let shared = shared.clone();
            thread::Builder::new()
                .name(format!("meeting-{meeting}"))
                .spawn(move || {
                    run(dir, log, opts, &shared);
                    shared.finish();
                })
        };
        let thread = match thread {
            Ok(thread) => Some(thread),
            Err(e) => {
                shared.set(PipelineState::Failed {
                    reason: format!("Voice couldn't start transcribing: {e}"),
                });
                shared.finish();
                None
            }
        };
        PipelineHandle {
            meeting,
            shared,
            thread,
        }
    }
}

/// A running pipeline. Dropping it asks the pipeline to stop without waiting.
pub struct PipelineHandle {
    meeting: String,
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl PipelineHandle {
    pub fn meeting(&self) -> &str {
        &self.meeting
    }

    pub fn state(&self) -> PipelineState {
        self.shared.state()
    }

    /// Looks again now instead of at the next poll, for instance after the user gave consent.
    pub fn wake(&self) {
        self.shared.wake();
    }

    /// Stops following the meeting, for an app that quits. The recorder isn't touched. Waits up
    /// to 5 s for a recognition call that is running; what it returns is still stored.
    pub fn shutdown(mut self) {
        self.shared.request_stop();
        if self.shared.wait_finished(SHUTDOWN_WAIT) {
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

impl Drop for PipelineHandle {
    fn drop(&mut self) {
        self.shared.request_stop();
    }
}

impl fmt::Debug for PipelineHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PipelineHandle")
            .field("meeting", &self.meeting)
            .field("state", &self.state())
            .finish()
    }
}

#[derive(Default)]
struct Shared {
    state: Mutex<Option<PipelineState>>,
    stop: AtomicBool,
    flags: Mutex<Flags>,
    signal: Condvar,
}

#[derive(Default)]
struct Flags {
    woken: bool,
    finished: bool,
}

impl Shared {
    fn state(&self) -> PipelineState {
        lock(&self.state).clone().unwrap_or(PipelineState::Starting)
    }

    fn set(&self, state: PipelineState) {
        *lock(&self.state) = Some(state);
    }

    fn stopping(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.wake();
    }

    fn wake(&self) {
        lock(&self.flags).woken = true;
        self.signal.notify_all();
    }

    /// Sleeps for `wait`, or until woken or asked to stop.
    fn sleep(&self, wait: Duration) {
        let flags = lock(&self.flags);
        let (mut flags, _) = self
            .signal
            .wait_timeout_while(flags, wait, |f| !f.woken && !self.stopping())
            .unwrap_or_else(PoisonError::into_inner);
        flags.woken = false;
    }

    fn finish(&self) {
        {
            let mut state = lock(&self.state);
            if !state.as_ref().is_some_and(PipelineState::is_final) {
                *state = Some(PipelineState::Stopped);
            }
        }
        lock(&self.flags).finished = true;
        self.signal.notify_all();
    }

    fn wait_finished(&self, wait: Duration) -> bool {
        let flags = lock(&self.flags);
        let (flags, _) = self
            .signal
            .wait_timeout_while(flags, wait, |f| !f.finished)
            .unwrap_or_else(PoisonError::into_inner);
        flags.finished
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn run(dir: MeetingDir, log: EventLog, opts: PipelineOptions, shared: &Shared) {
    let timing = opts.timing.clone();
    let mut errors = 0u32;
    let mut worker = loop {
        if shared.stopping() {
            return;
        }
        match Worker::open(dir.clone(), log.clone(), &opts) {
            Ok(Some(worker)) => break worker,
            Ok(None) => return,
            Err(e) => {
                errors += 1;
                shared.set(PipelineState::Retrying {
                    error: e.to_string(),
                });
                shared.sleep(backoff(&timing, errors));
            }
        }
    };
    errors = 0;
    while !shared.stopping() {
        match worker.step(shared) {
            Ok(Step::Progress) => {
                errors = 0;
                shared.sleep(timing.busy_poll);
            }
            Ok(Step::Idle) => {
                errors = 0;
                shared.sleep(timing.poll);
            }
            Ok(Step::Finished) | Ok(Step::Gone) => return,
            Err(e) => {
                // A full disk or a locked file: the recording is safe, so try again later.
                errors += 1;
                shared.set(PipelineState::Retrying {
                    error: e.to_string(),
                });
                shared.sleep(backoff(&timing, errors));
            }
        }
    }
}

fn backoff(timing: &Timing, attempts: u32) -> Duration {
    let doublings = attempts.saturating_sub(1).min(16);
    timing
        .retry_first
        .saturating_mul(1 << doublings)
        .min(timing.retry_max)
}

#[derive(Debug)]
enum Error {
    Db(rusqlite::Error),
    Log(LogError),
    Io(io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Db(e) => write!(f, "the transcript store failed: {e}"),
            Error::Log(e) => write!(f, "{e}"),
            Error::Io(e) => write!(f, "the meeting folder can't be read: {e}"),
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Error {
        Error::Db(e)
    }
}

impl From<LogError> for Error {
    fn from(e: LogError) -> Error {
        Error::Log(e)
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Error {
        Error::Io(e)
    }
}

enum Step {
    Progress,
    Idle,
    Finished,
    Gone,
}

enum Advance {
    /// A window or a gap was stored.
    Moved,
    /// The track needs more audio first.
    Waiting,
    /// The recording ended and every second of the track is transcribed.
    Complete,
    /// Recognition failed; wait before the next try.
    Backoff,
    /// Recognition failed too often after the recording ended.
    GiveUp(String),
}

/// Failed recognitions in a row.
struct Failure {
    attempts: u32,
    after_stop: u32,
    until: Instant,
}

/// The speaker a track's passages belong to. Voice 0.1 labels the whole call as one speaker.
pub fn speaker_of(track: Track) -> Speaker {
    let (id, label) = match track {
        Track::Mic => ("mic", "You"),
        Track::Call => ("call-1", "Speaker 1"),
    };
    Speaker {
        id: id.to_owned(),
        track,
        label: label.to_owned(),
    }
}

fn passage_key(id: &str, revision: u64) -> String {
    format!("passage:{id}:{revision}")
}

/// The key of an event already in the log, as the pipeline would have made it.
fn event_key(event: &str, data: &Value) -> Option<String> {
    let text = |key: &str| data[key].as_str();
    Some(match event {
        events::MEETING_STARTED => "started".to_owned(),
        events::MEETING_STATE => {
            state_key(MeetingState::parse(text("state")?)?, data["at"].as_u64()?)
        }
        events::SPEAKER => format!("speaker:{}", text("id")?),
        events::PASSAGE => passage_key(text("id")?, data["revision"].as_u64()?),
        events::MARK => mark_key(text("id")?),
        _ => return None,
    })
}

fn to_data(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value).expect("protocol types serialize")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

struct Worker {
    dir: MeetingDir,
    id: String,
    file: MeetingFile,
    log: EventLog,
    transcript: Transcript,
    emitted: HashSet<String>,
    watcher: TimelineWatcher,
    recognizer: Recognizer,
    hints: Hints,
    allowed: ConsentCheck,
    timing: Timing,
    tracks: Vec<Track>,
    /// Samples of segments that ended, which can't change any more.
    lengths: HashMap<(String, u64), u64>,
    /// The dictation stretches the passages were last flagged with.
    stretches: Vec<Stretch>,
    failure: Option<Failure>,
    next_track: usize,
    begun: bool,
}

impl Worker {
    /// `None` when the meeting is gone.
    fn open(
        dir: MeetingDir,
        log: EventLog,
        opts: &PipelineOptions,
    ) -> Result<Option<Worker>, Error> {
        if !dir.path().is_dir() {
            return Ok(None);
        }
        let file = dir.meeting()?;
        let mut transcript = Transcript::open(dir.path())?;
        let id = dir.id().to_string();
        let (_, stored) = log.meeting_events(&id)?;
        if stored.iter().any(|e| e.event == events::MEETING_REMOVED) {
            return Ok(None);
        }
        // The log is the record of what Rukoo can get. A key the store remembers but the log
        // lacks (a power cut lost it) is sent again; one the log has but the store doesn't (Voice
        // died between the two writes) isn't.
        let keys: HashMap<String, u64> = stored
            .iter()
            .filter_map(|e| Some((event_key(&e.event, &e.data)?, e.seq)))
            .collect();
        if transcript.emitted()? != keys {
            transcript.set_emitted(&keys)?;
        }
        let recognizer = match &opts.timed {
            Some(timed) => Recognizer::Timed(timed.clone()),
            None => Recognizer::Text(opts.stt.clone()),
        };
        Ok(Some(Worker {
            watcher: TimelineWatcher::new(dir.path()),
            tracks: tracks_of(&file.tracks),
            dir,
            id,
            file,
            log,
            transcript,
            emitted: keys.into_keys().collect(),
            recognizer,
            hints: opts.hints.clone(),
            allowed: opts.transcription_allowed.clone(),
            timing: opts.timing.clone(),
            lengths: HashMap::new(),
            stretches: Vec::new(),
            failure: None,
            next_track: 0,
            begun: false,
        }))
    }

    /// Sends an event unless the log has it already.
    fn emit(&mut self, key: String, event: &str, data: Value) -> Result<(), Error> {
        if self.emitted.contains(&key) {
            return Ok(());
        }
        match self.log.append(event, Some(&self.id), data) {
            Ok(seq) => self.transcript.record_emitted(&key, seq)?,
            // A bug built an event Rukoo would drop; sending it again can't help.
            Err(e @ (LogError::Invalid(_) | LogError::TooLarge { .. })) => {
                eprintln!("voice-meetings: {}: dropped a {event} event: {e}", self.id);
            }
            Err(e) => return Err(e.into()),
        }
        self.emitted.insert(key);
        Ok(())
    }

    fn emit_passage(&mut self, passage: &Passage) -> Result<(), Error> {
        self.emit(
            passage_key(&passage.id, passage.revision),
            events::PASSAGE,
            to_data(passage),
        )
    }

    fn emit_speaker(&mut self, track: Track) -> Result<(), Error> {
        let speaker = speaker_of(track);
        self.transcript.save_speaker(&speaker)?;
        self.emit(
            format!("speaker:{}", speaker.id),
            events::SPEAKER,
            to_data(&speaker),
        )
    }

    /// The events that come before anything recorded, and passages a pipeline before this one
    /// stored but didn't send.
    fn begin(&mut self) -> Result<(), Error> {
        self.emit(
            "started".into(),
            events::MEETING_STARTED,
            self.file.started(),
        )?;
        for track in self.tracks.clone() {
            self.emit_speaker(track)?;
        }
        for stored in self.transcript.passages()? {
            self.emit_passage(&stored.passage)?;
        }
        self.begun = true;
        Ok(())
    }

    fn step(&mut self, shared: &Shared) -> Result<Step, Error> {
        if !self.dir.path().is_dir() {
            return Ok(Step::Gone);
        }
        if !self.begun {
            self.begin()?;
        }
        for derived in self.watcher.poll()? {
            self.apply(derived)?;
        }
        self.follow_new_tracks()?;
        self.flag_dictation()?;
        let stop = self.watcher.mapper().stop().cloned();

        if let Err(reason) = (self.allowed)() {
            shared.set(PipelineState::Waiting { reason });
            return Ok(Step::Idle);
        }
        if self
            .failure
            .as_ref()
            .is_some_and(|f| Instant::now() < f.until)
        {
            return Ok(Step::Idle);
        }
        if stop.is_none() && self.dictating() {
            shared.set(PipelineState::Listening);
            return Ok(Step::Idle);
        }

        let count = self.tracks.len();
        let mut complete = true;
        for k in 0..count {
            let i = (self.next_track + k) % count;
            match self.advance(self.tracks[i], stop.is_some(), shared)? {
                Advance::Moved => {
                    self.next_track = (i + 1) % count;
                    if self.failure.is_none() {
                        shared.set(PipelineState::Listening);
                    }
                    return Ok(Step::Progress);
                }
                Advance::Waiting => complete = false,
                Advance::Complete => {}
                Advance::Backoff => return Ok(Step::Idle),
                Advance::GiveUp(reason) => {
                    if let Some(stop) = &stop {
                        self.fail(stop, reason.clone())?;
                    }
                    shared.set(PipelineState::Failed { reason });
                    return Ok(Step::Finished);
                }
            }
        }
        match stop {
            Some(stop) if complete => {
                self.done(&stop)?;
                shared.set(PipelineState::Done);
                Ok(Step::Finished)
            }
            _ => {
                if self.failure.is_none() {
                    shared.set(PipelineState::Listening);
                }
                Ok(Step::Idle)
            }
        }
    }

    fn apply(&mut self, derived: Derived) -> Result<(), Error> {
        let key = derived.key();
        match derived {
            Derived::Mark(mark) => {
                self.transcript.save_mark(&mark)?;
                self.emit(key, events::MARK, to_data(&mark))
            }
            Derived::State(change) => {
                if change.state == MeetingState::Processing && self.transcript.outcome()?.is_none()
                {
                    self.transcript.set_outcome(&Outcome {
                        state: MeetingState::Processing,
                        at: change.at,
                        ended_at: change.ended_at.unwrap_or_else(now_ms),
                        reason: change.reason.clone(),
                        done_at: None,
                    })?;
                }
                self.emit(key, events::MEETING_STATE, to_data(&change))
            }
        }
    }

    /// A track the recorder records that meeting.json didn't name gets followed too.
    fn follow_new_tracks(&mut self) -> Result<(), Error> {
        let seen = tracks_of(
            self.watcher
                .mapper()
                .segments()
                .iter()
                .map(|s| s.track.as_str()),
        );
        for track in seen {
            if !self.tracks.contains(&track) {
                self.tracks.push(track);
                self.tracks.sort();
                self.emit_speaker(track)?;
            }
        }
        Ok(())
    }

    /// Marks the microphone's passages that overlap a dictation stretch, and unmarks them when a
    /// stretch turns out shorter. A changed flag is a new revision.
    fn flag_dictation(&mut self) -> Result<(), Error> {
        let stretches = self.watcher.mapper().stretches();
        if stretches == self.stretches {
            return Ok(());
        }
        self.stretches = stretches;
        for stored in self.transcript.passages()? {
            let mut passage = stored.passage;
            let dictation = self.in_dictation(passage.track, passage.start, passage.end);
            if dictation != passage.dictation {
                passage.dictation = dictation;
                passage.revision += 1;
                self.transcript.update_passage(&passage)?;
                self.emit_passage(&passage)?;
            }
        }
        Ok(())
    }

    /// Dictation goes into the microphone; the call track carries the other people.
    fn in_dictation(&self, track: Track, start: u64, end: u64) -> bool {
        track == Track::Mic
            && self
                .watcher
                .mapper()
                .stretches()
                .iter()
                .any(|s| s.overlaps(start, end))
    }

    fn dictating(&self) -> bool {
        let mapper = self.watcher.mapper();
        mapper
            .dictating_since()
            .is_some_and(|since| mapper.latest_t().saturating_sub(since) < DICTATION_YIELD_MS)
    }

    fn reader(&mut self, track: Track) -> TrackReader {
        let dir = self.dir.path().to_owned();
        let lengths = &mut self.lengths;
        TrackReader::with_lengths(
            &dir,
            track.as_str(),
            self.watcher.mapper().segments(),
            |s| match s.ended {
                Some(ended) => *lengths
                    .entry((s.track.clone(), s.seq))
                    .or_insert_with(|| segment_samples(&dir.join(&s.file), Some(ended))),
                None => segment_samples(&dir.join(&s.file), None),
            },
        )
    }

    /// The meeting sample up to which the track's audio is settled: recorded, or known to be a
    /// gap that no later segment can fill.
    fn horizon(&self, track: Track, reader: &TrackReader, stopped: bool) -> u64 {
        let end = reader.end();
        let mapper = self.watcher.mapper();
        let open = mapper
            .segments()
            .iter()
            .any(|s| s.track == track.as_str() && s.ended.is_none());
        if stopped || open {
            end
        } else {
            end.max(mapper.latest_t().saturating_sub(SETTLE_MS) * PER_MS)
        }
    }

    /// Transcribes the track's next window, or moves past a gap.
    fn advance(&mut self, track: Track, stopped: bool, shared: &Shared) -> Result<Advance, Error> {
        let reader = self.reader(track);
        let horizon = self.horizon(track, &reader, stopped);
        let cursor = self.transcript.cursor(track)?;
        if cursor >= horizon {
            return Ok(if stopped {
                Advance::Complete
            } else {
                Advance::Waiting
            });
        }
        if !reader.covered(cursor) {
            let target = match reader.next_audio(cursor) {
                Some(next) => next.min(horizon),
                None if horizon - cursor >= GAP_STEP => horizon,
                None => return Ok(Advance::Waiting),
            };
            return self.commit(track, cursor, target, "gap", Vec::new());
        }

        // A window never runs into a gap (a crash, a lost device, a pause): once the gap is
        // settled, the audio before it ends as if the recording ended there.
        let span_end = reader.span_end(cursor, DRIFT_GAP).unwrap_or(horizon);
        let gap_ahead = span_end + DRIFT_GAP <= horizon;
        let limit = if gap_ahead { span_end } else { horizon };

        let timed = self.recognizer.is_timed();
        let left = if timed {
            cursor.saturating_sub(LEFT_CONTEXT as u64)
        } else {
            cursor
        };
        let read_end = (cursor + (CORE_LIMIT + RIGHT_CONTEXT) as u64).min(limit);
        let data = reader.read(left, read_end)?;
        let from = (cursor - left) as usize;
        let last = read_end == limit && (stopped || gap_ahead);
        let Some(boundary) = next_boundary(&data[from..], last) else {
            return Ok(Advance::Waiting);
        };
        let until = from + boundary.end;
        let end = cursor + boundary.end as u64;

        let mut drafts = Vec::new();
        let mut language = None;
        if worth_recognizing(&data[from..until]) {
            shared.set(PipelineState::Transcribing);
            let right = if timed { until + RIGHT_CONTEXT } else { until }.min(data.len());
            match self.recognizer.recognize(&data[..right], &self.hints) {
                Ok(Heard::Timed(t)) => {
                    let seconds = |samples: u64| samples as f64 / RATE as f64;
                    let owned = owned_tokens(
                        &t.tokens,
                        &t.timestamps,
                        &t.durations,
                        seconds(left),
                        seconds(cursor),
                        seconds(end),
                    );
                    drafts = timed_passages(&owned);
                    within(&mut drafts, cursor / PER_MS, end / PER_MS);
                    language = t.language;
                }
                Ok(Heard::Text(text, lang)) => {
                    drafts.extend(window_passage(&text, cursor / PER_MS, end / PER_MS));
                    language = lang;
                }
                Err(e) => return Ok(self.recognition_failed(e, stopped, shared)),
            }
            self.failure = None;
        }
        let passages = drafts
            .into_iter()
            .map(|draft| self.passage(track, draft, language.clone()))
            .collect();
        self.commit(track, cursor, end, boundary.reason.as_str(), passages)
    }

    fn passage(&self, track: Track, draft: Draft, language: Option<String>) -> StoredPassage {
        StoredPassage {
            passage: Passage {
                // The store gives it the id that goes with its start.
                id: String::new(),
                track,
                speaker: Some(speaker_of(track).id),
                start: draft.start,
                end: draft.end,
                dictation: self.in_dictation(track, draft.start, draft.end),
                text: draft.text,
                revision: 1,
                language,
            },
            tokens: draft.tokens,
        }
    }

    fn commit(
        &mut self,
        track: Track,
        start: u64,
        end: u64,
        reason: &str,
        passages: Vec<StoredPassage>,
    ) -> Result<Advance, Error> {
        // `None`: another pipeline moved the cursor first; the next look reads it again.
        if let Some(stored) = self
            .transcript
            .commit_window(track, start, end, reason, passages)?
        {
            for p in stored {
                self.emit_passage(&p.passage)?;
            }
        }
        Ok(Advance::Moved)
    }

    fn recognition_failed(&mut self, e: ProviderError, stopped: bool, shared: &Shared) -> Advance {
        let failure = self.failure.get_or_insert(Failure {
            attempts: 0,
            after_stop: 0,
            until: Instant::now(),
        });
        failure.attempts += 1;
        if stopped {
            failure.after_stop += 1;
        }
        failure.until = Instant::now() + backoff(&self.timing, failure.attempts);
        let message = if e.message.trim().is_empty() {
            "The speech recognizer failed.".to_owned()
        } else {
            e.message
        };
        if stopped && failure.after_stop >= self.timing.attempts_after_stop {
            return Advance::GiveUp(message);
        }
        shared.set(PipelineState::Retrying { error: message });
        Advance::Backoff
    }

    fn done(&mut self, stop: &Stop) -> Result<(), Error> {
        let change = MeetingStateChange {
            state: MeetingState::Done,
            at: stop.t,
            ended_at: Some(stop.wall),
            reason: None,
        };
        self.emit(
            state_key(MeetingState::Done, stop.t),
            events::MEETING_STATE,
            to_data(&change),
        )?;
        let finished = self.transcript.outcome()?;
        // A pipeline that runs again over a finished meeting keeps the first time it was done,
        // which the retention clock counts from.
        if finished
            .as_ref()
            .is_none_or(|o| o.state != MeetingState::Done)
        {
            self.transcript.set_outcome(&Outcome {
                state: MeetingState::Done,
                at: stop.t,
                ended_at: stop.wall,
                reason: Some(stop.reason.clone()),
                done_at: Some(now_ms()),
            })?;
        }
        Ok(())
    }

    fn fail(&mut self, stop: &Stop, reason: String) -> Result<(), Error> {
        let change = MeetingStateChange {
            state: MeetingState::Failed,
            at: stop.t,
            ended_at: Some(stop.wall),
            reason: Some(reason.clone()),
        };
        self.emit(
            state_key(MeetingState::Failed, stop.t),
            events::MEETING_STATE,
            to_data(&change),
        )?;
        self.transcript.set_outcome(&Outcome {
            state: MeetingState::Failed,
            at: stop.t,
            ended_at: stop.wall,
            reason: Some(reason),
            done_at: None,
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_up_to_the_limit() {
        let timing = Timing::default();
        assert_eq!(backoff(&timing, 1), Duration::from_secs(2));
        assert_eq!(backoff(&timing, 3), Duration::from_secs(8));
        assert_eq!(backoff(&timing, 40), Duration::from_secs(60));
    }

    #[test]
    fn events_already_in_the_log_get_the_keys_the_pipeline_gives_them() {
        let passage = serde_json::json!({"id":"mic-000001000","revision":2});
        assert_eq!(
            event_key("passage", &passage).as_deref(),
            Some("passage:mic-000001000:2")
        );
        let state = serde_json::json!({"state":"paused","at":4000});
        assert_eq!(
            event_key("meeting.state", &state).as_deref(),
            Some("state:paused:4000")
        );
        assert_eq!(
            event_key("mark", &serde_json::json!({"id":"k-1"})).as_deref(),
            Some("mark:k-1")
        );
        assert_eq!(event_key("status", &serde_json::json!({})), None);
        assert_eq!(event_key("passage", &serde_json::json!({"id": 1})), None);
    }

    #[test]
    fn the_speakers_of_voice_0_1() {
        assert_eq!(speaker_of(Track::Mic).label, "You");
        assert_eq!(speaker_of(Track::Call).id, "call-1");
        assert_eq!(speaker_of(Track::Call).label, "Speaker 1");
    }
}
