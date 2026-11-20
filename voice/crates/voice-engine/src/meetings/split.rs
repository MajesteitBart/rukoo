//! `speakers.split` for the bridge (voice/PROTOCOL.md): tells apart the voices at the microphone
//! of a stopped meeting with Nemotron on this computer, also in a meeting that Mistral's realtime
//! model transcribed.
//!
//! `split` runs on the bridge's command thread, so it only checks and looks up and answers within
//! milliseconds. The split itself (`voice_meetings::split_microphone`) runs as a job per meeting
//! and track on a `speakers-split` thread in the platform's background mode, and its worker runs
//! below normal priority as the follower's does; Rukoo asks again until it is done. A finished
//! split is stored in the meeting's `transcript.db`, so the same command answers `done` after a
//! restart too and never splits again. A failure is answered once and the next command starts
//! over, as is a split a quit cut off, which stored nothing. A quit between storing a split and
//! sending its events is caught up at the next start ([`SplitService::catch_up`]), and again
//! before the next `done`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::thread;

use serde_json::Value;
use voice_bridge::{split_reasons, ControlError, EventLog, SplitResult, Track};
use voice_core::speakers::{DiarErrorKind, Diarizer, Unavailable};
use voice_meetings::{FollowerTiming, MeetingDir, SplitError};

use super::controller::Controller;

/// Opens Nemotron for a split, or says why it can't run on this computer: the speech services'
/// [`diarizer`](crate::services::Speech::diarizer).
pub type Diarizers = Arc<dyn Fn() -> Result<Arc<dyn Diarizer>, Unavailable> + Send + Sync>;

const NO_MEETING: &str = "There is no meeting with that id.";

/// How far a running split got, in meeting ms.
#[derive(Default)]
struct Progress {
    at: AtomicU64,
    end: AtomicU64,
}

impl Progress {
    fn answer(&self) -> Value {
        SplitResult::Running {
            at: self.at.load(Ordering::SeqCst),
            end: self.end.load(Ordering::SeqCst),
        }
        .to_value()
    }
}

enum Job {
    Running(Arc<Progress>),
    Done(u64),
    /// Answered once; the next command starts over.
    Failed(ControlError),
}

/// The splits this Voice runs or ran, by meeting and track.
pub struct SplitService {
    controller: Arc<Controller>,
    log: EventLog,
    diarizers: Diarizers,
    timing: FollowerTiming,
    jobs: Mutex<HashMap<(String, Track), Job>>,
    stopping: Arc<AtomicBool>,
    this: Weak<SplitService>,
}

impl SplitService {
    pub fn new(
        controller: Arc<Controller>,
        log: EventLog,
        diarizers: Diarizers,
    ) -> Arc<SplitService> {
        Arc::new_cyclic(|this| SplitService {
            controller,
            log,
            diarizers,
            timing: FollowerTiming::default(),
            jobs: Mutex::new(HashMap::new()),
            stopping: Arc::new(AtomicBool::new(false)),
            this: this.clone(),
        })
    }

    /// A service whose splits never run, for tests of everything else: Nemotron isn't available.
    pub fn unavailable(controller: Arc<Controller>, log: EventLog) -> Arc<SplitService> {
        SplitService::new(controller, log, Arc::new(|| Err(Unavailable::Platform)))
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<(String, Track), Job>> {
        self.jobs.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `{ state: "running", at, end }` while the split runs, then `{ state: "done", voices }`.
    pub fn split(&self, id: &str, track: Track) -> Result<Value, ControlError> {
        if track != Track::Mic {
            return Err(ControlError::bad_request(
                "Voice splits only the microphone into voices.",
            ));
        }
        let dir = self
            .controller
            .library()
            .dir(id)
            .ok_or_else(|| ControlError::not_found(NO_MEETING))?;
        let key = (id.to_owned(), track);
        if let Some(answer) = self.known(&key) {
            return answer;
        }
        self.stopped(id)?;
        // Split by this run or an earlier one: the events it still owes go out first.
        if voice_meetings::split_voices(&dir)
            .map_err(|e| split_error(id, e))?
            .is_some()
        {
            let voices =
                voice_meetings::send_split(&dir, &self.log).map_err(|e| split_error(id, e))?;
            self.lock().insert(key, Job::Done(voices));
            return Ok(SplitResult::Done { voices }.to_value());
        }
        let diarizer = (self.diarizers)().map_err(|why| {
            ControlError::not_available(why.to_string()).with_reason(unavailable_reason(&why))
        })?;
        let end = voice_meetings::microphone_end(&dir).map_err(|e| split_error(id, e))?;
        if end == 0 {
            return Err(split_error(id, SplitError::NoAudio));
        }
        self.start(key, dir, diarizer, end)
    }

    /// The answer of a job this Voice runs or ran. A failure is answered once.
    fn known(&self, key: &(String, Track)) -> Option<Result<Value, ControlError>> {
        let mut jobs = self.lock();
        match jobs.get(key)? {
            Job::Running(progress) => Some(Ok(progress.answer())),
            Job::Done(voices) => Some(Ok(SplitResult::Done { voices: *voices }.to_value())),
            Job::Failed(_) => match jobs.remove(key) {
                Some(Job::Failed(error)) => Some(Err(error)),
                _ => None,
            },
        }
    }

    /// `busy` unless the meeting ended and its transcription is `done` or `failed`.
    fn stopped(&self, id: &str) -> Result<(), ControlError> {
        if self.controller.current().is_some_and(|r| r.id == id) {
            return Err(ControlError::busy(id, "The meeting is still recording."));
        }
        let snapshot = self
            .controller
            .library()
            .get(id, &self.log)
            .ok_or_else(|| ControlError::not_found(NO_MEETING))?;
        match snapshot["meeting"]["state"].as_str() {
            Some("done" | "failed") => Ok(()),
            Some("processing") => Err(ControlError::busy(
                id,
                "Voice is still transcribing the meeting.",
            )),
            _ => Err(ControlError::busy(id, "The meeting is still recording.")),
        }
    }

    /// Starts the job on its own thread and answers `running`.
    fn start(
        &self,
        key: (String, Track),
        dir: MeetingDir,
        diarizer: Arc<dyn Diarizer>,
        end: u64,
    ) -> Result<Value, ControlError> {
        let progress = Arc::new(Progress::default());
        progress.end.store(end, Ordering::SeqCst);
        {
            let mut jobs = self.lock();
            // Another connection asked first.
            if let Some(Job::Running(running)) = jobs.get(&key) {
                return Ok(running.answer());
            }
            jobs.insert(key.clone(), Job::Running(Arc::clone(&progress)));
        }
        let this = self.this.clone();
        let job = key.clone();
        let started = thread::Builder::new()
            .name(format!("speakers-split-{}", key.0))
            .spawn(move || run(this, job, dir, diarizer, progress));
        if started.is_err() {
            self.lock().remove(&key);
            return Err(ControlError::failed(
                "Voice couldn't start telling the voices apart.",
            ));
        }
        Ok(SplitResult::Running { at: 0, end }.to_value())
    }

    /// At start, before the bridge serves and before any pipeline runs: sends what the splits an
    /// earlier run stored still owe Rukoo, as when Voice quit between storing a split and sending
    /// its events. A Rukoo that never asks about that meeting again still gets them. A meeting
    /// costs one read of its `transcript.db`, also a split one whose events all went to this
    /// event log; only a split that never finished sending is read in full. No diarizer runs.
    pub fn catch_up(&self) {
        for dir in self.controller.library().dirs() {
            match voice_meetings::catch_up_split(&dir, &self.log) {
                Ok(0) => {}
                Ok(sent) => log::info!(
                    "speakers: {}: sent {sent} events of the microphone split",
                    dir.id()
                ),
                Err(e) => log::warn!(
                    "speakers: {}: couldn't send the microphone split's events: {e}",
                    dir.id()
                ),
            }
        }
    }

    /// Whether a split runs now, so the speaker model stays.
    pub fn running(&self) -> bool {
        self.lock()
            .values()
            .any(|job| matches!(job, Job::Running(_)))
    }

    /// Stops the splits that run at their next push. They store nothing and start over at the
    /// next command.
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
    }
}

/// A `speakers-split` thread: one split, then its answer for the next command.
fn run(
    service: Weak<SplitService>,
    key: (String, Track),
    dir: MeetingDir,
    diarizer: Arc<dyn Diarizer>,
    progress: Arc<Progress>,
) {
    crate::platform::background_thread();
    let Some(this) = service.upgrade() else {
        return;
    };
    let report = |at: u64, end: u64| {
        progress.at.store(at, Ordering::SeqCst);
        progress.end.store(end, Ordering::SeqCst);
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        voice_meetings::split_microphone(
            &dir,
            &this.log,
            diarizer.as_ref(),
            &this.timing,
            &this.stopping,
            &report,
        )
    }));
    let job = match result {
        Ok(Ok(voices)) => {
            log::info!("speakers: {}: the microphone has {voices} voices", key.0);
            Some(Job::Done(voices))
        }
        // Cut off by a quit, or the meeting went: nothing was stored, and nothing is answered.
        Ok(Err(SplitError::Stopped)) => None,
        Ok(Err(error)) => {
            log::info!("speakers: {}: the split failed: {error}", key.0);
            Some(Job::Failed(split_error(&key.0, error)))
        }
        Err(_) => {
            log::error!("speakers: {}: the split panicked", key.0);
            Some(Job::Failed(ControlError::failed(
                "Voice failed while telling the voices apart.",
            )))
        }
    };
    let mut jobs = this.lock();
    match job {
        Some(job) => jobs.insert(key, job),
        None => jobs.remove(&key),
    };
}

/// The reason Settings › Speaker labels gives, in the three `speakers.split` knows: what the
/// processor or the platform can't run, a runtime that is missing or failed to load, and a model
/// that is missing or damaged.
fn unavailable_reason(why: &Unavailable) -> &'static str {
    match why {
        Unavailable::Platform | Unavailable::Cpu { .. } => split_reasons::CPU,
        Unavailable::Runtime | Unavailable::NotPublished | Unavailable::RuntimeFailed { .. } => {
            split_reasons::RUNTIME
        }
        Unavailable::Model | Unavailable::ModelDamaged { .. } => split_reasons::MODEL,
    }
}

/// A split of meeting `id` that didn't finish, in the bridge's codes.
fn split_error(id: &str, error: SplitError) -> ControlError {
    match error {
        SplitError::Stopped => ControlError::not_found(NO_MEETING),
        SplitError::Recording => ControlError::busy(id, "The meeting is still recording."),
        SplitError::NoAudio => ControlError::not_available(
            "The microphone's audio of this meeting is no longer on this computer.",
        )
        .with_reason(split_reasons::AUDIO),
        // A worker that refuses to load can't run here, as Settings would say by now.
        SplitError::Worker(e) => match e.kind {
            DiarErrorKind::Cpu => {
                ControlError::not_available(e.message).with_reason(split_reasons::CPU)
            }
            DiarErrorKind::Runtime => {
                ControlError::not_available(e.message).with_reason(split_reasons::RUNTIME)
            }
            DiarErrorKind::Model => {
                ControlError::not_available(e.message).with_reason(split_reasons::MODEL)
            }
            _ => ControlError::failed(format!("The speaker worker failed: {}", e.message)),
        },
        SplitError::Store(message) => ControlError::failed(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_settings_reason_is_one_of_the_split_s() {
        let all = [
            Unavailable::Platform,
            Unavailable::Cpu {
                missing: vec!["bmi2".into()],
            },
            Unavailable::Runtime,
            Unavailable::NotPublished,
            Unavailable::RuntimeFailed {
                detail: "no".into(),
            },
            Unavailable::Model,
            Unavailable::ModelDamaged {
                detail: "no".into(),
            },
        ];
        let reasons: Vec<&str> = all.iter().map(unavailable_reason).collect();
        assert_eq!(
            reasons,
            ["cpu", "cpu", "runtime", "runtime", "runtime", "model", "model"]
        );
    }
}
