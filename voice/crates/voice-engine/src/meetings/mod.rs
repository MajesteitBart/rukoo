//! Meetings: the recorder controller, the bridge for Rukoo, and the voice-meetings pipelines that
//! transcribe each meeting and send its events.

pub mod bridge;
pub mod controller;
pub mod tap;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;

use serde_json::json;
use voice_bridge::EventLog;
use voice_core::config::{Config, Retention};
use voice_core::consent::ConsentState;
use voice_meetings::{Pipeline, PipelineHandle};
use voice_protocol::MeetingState;

pub use voice_meetings::{Library, PipelineOptions, PipelineState};

use self::bridge::{Bridge, Control};
use self::controller::Controller;
use crate::services::{AudioSink, MicStream};

pub struct Meetings {
    pub controller: Arc<Controller>,
    pub log: Option<EventLog>,
    pub bridge: Option<Bridge>,
    dictating: Arc<AtomicBool>,
    pipelines: Mutex<Vec<PipelineHandle>>,
    published: Mutex<Option<(Option<String>, bool)>>,
}

impl Meetings {
    pub fn new(
        controller: Arc<Controller>,
        log: Option<EventLog>,
        discovery_path: Option<PathBuf>,
        version: &str,
    ) -> Meetings {
        let dictating = Arc::new(AtomicBool::new(false));
        let bridge = match (&log, discovery_path) {
            (Some(log), Some(path)) => Some(Bridge::start(
                log.clone(),
                Arc::new(Control {
                    controller: Arc::clone(&controller),
                    log: log.clone(),
                    dictating: Arc::clone(&dictating),
                }),
                path,
                version,
            )),
            _ => None,
        };
        Meetings {
            controller,
            log,
            bridge,
            dictating,
            pipelines: Mutex::new(Vec::new()),
            published: Mutex::new(None),
        }
    }

    pub fn library(&self) -> &Library {
        self.controller.library()
    }

    pub fn rukoo_connected(&self) -> bool {
        self.bridge.as_ref().is_some_and(|b| b.rukoo().connected())
    }

    /// Transcribes a meeting and sends its events to Rukoo: one pipeline per meeting at a time.
    /// A pipeline resumes from `transcript.db`, so following a meeting again never repeats an
    /// event.
    pub fn follow(&self, id: &str, opts: PipelineOptions) {
        let Some(log) = &self.log else {
            return;
        };
        let Some(dir) = self.library().dir(id) else {
            return;
        };
        let mut pipelines = self.lock();
        pipelines.retain(|p| !p.state().is_final());
        if pipelines.iter().any(|p| p.meeting() == id) {
            return;
        }
        pipelines.push(Pipeline::start(dir, log.clone(), opts));
    }

    /// Meetings that stopped but aren't transcribed: the app quit while they were processing,
    /// or their transcription failed. The next start tries again.
    pub fn unfinished(&self) -> Vec<String> {
        self.library()
            .list(usize::MAX)
            .into_iter()
            .filter(|m| matches!(m.state, MeetingState::Processing | MeetingState::Failed))
            .map(|m| m.id.into_string())
            .collect()
    }

    /// The meetings a pipeline follows now, with what each is doing.
    pub fn pipelines(&self) -> Vec<(String, PipelineState)> {
        self.lock()
            .iter()
            .map(|p| (p.meeting().to_string(), p.state()))
            .collect()
    }

    /// Lets every pipeline look again now, for instance after the user gave consent.
    pub fn wake(&self) {
        for pipeline in self.lock().iter() {
            pipeline.wake();
        }
    }

    /// Starts every running pipeline again with new options, after the meeting provider or its
    /// words changed. Blocks while the old ones finish a recognition call (up to 5 s each).
    pub fn restart(&self, options: impl Fn() -> PipelineOptions) {
        let old = std::mem::take(&mut *self.lock());
        let ids: Vec<String> = old
            .iter()
            .filter(|p| !p.state().is_final())
            .map(|p| p.meeting().to_string())
            .collect();
        shutdown_all(old);
        for id in ids {
            self.follow(&id, options());
        }
    }

    /// Removes the audio of meetings whose retention ran out (Ownkey's rule; voice-meetings).
    pub fn sweep(&self, retention: Retention) -> Vec<String> {
        match &self.log {
            Some(log) => voice_meetings::retention_sweep(self.library(), log, |_| retention),
            None => Vec::new(),
        }
    }

    pub fn set_dictating(&self, on: bool) {
        self.dictating.store(on, Ordering::SeqCst);
        self.publish_status();
    }

    pub fn dictating(&self) -> bool {
        self.dictating.load(Ordering::SeqCst)
    }

    /// A `status` event when what Voice is doing changed. The log keeps only the newest one.
    pub fn publish_status(&self) {
        let Some(log) = &self.log else {
            return;
        };
        let recording = self.controller.current().map(|r| r.id);
        let dictating = self.dictating();
        let mut published = self
            .published
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if published.as_ref() == Some(&(recording.clone(), dictating)) {
            return;
        }
        if log
            .append(
                voice_protocol::events::STATUS,
                None,
                json!({"recording": recording, "dictating": dictating}),
            )
            .is_ok()
        {
            *published = Some((recording, dictating));
        }
    }

    /// The meeting's microphone for a dictation, or `None` without a meeting.
    pub fn open_tap(&self, on_audio: AudioSink) -> Option<Result<Box<dyn MicStream>, String>> {
        let file = self.controller.tap()?;
        Some(tap::open(&file, on_audio).map(|tap| Box::new(tap) as Box<dyn MicStream>))
    }

    /// Stops transcribing, the watchdog and the bridge. A recorder that records goes on.
    pub fn shutdown(&self) {
        shutdown_all(std::mem::take(&mut *self.lock()));
        self.controller.shutdown();
        if let Some(bridge) = &self.bridge {
            bridge.stop();
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<PipelineHandle>> {
        self.pipelines
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

/// Shuts pipelines down side by side: each may wait up to 5 s for a recognition call.
fn shutdown_all(pipelines: Vec<PipelineHandle>) {
    let waits: Vec<_> = pipelines
        .into_iter()
        .map(|p| thread::spawn(move || p.shutdown()))
        .collect();
    for wait in waits {
        let _ = wait.join();
    }
}

/// Decision 10's gate for a meeting's transcription: allowed with Orukeet, a local server or
/// valid consent for the saved provider and host; otherwise it waits and says why.
pub fn transcription_allowed(cfg: &Config) -> Result<(), String> {
    match cfg.meeting_consent() {
        ConsentState::NotNeeded | ConsentState::Granted => Ok(()),
        ConsentState::Required { label, host, .. } => Err(format!(
            "Transcription waits until you allow sending meeting audio to {label} at {host} in Settings > Meetings > Transcription."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use voice_core::config::Consent;

    #[test]
    fn transcription_waits_for_consent_but_never_for_orukeet() {
        let mut cfg = Config::defaults(false);
        assert_eq!(transcription_allowed(&cfg), Ok(()));
        cfg.switch_meeting_provider("mistral");
        cfg.meetings_audio_model = "voxtral-mini-latest".into();
        let waiting = transcription_allowed(&cfg).unwrap_err();
        assert!(waiting.contains("Mistral at api.mistral.ai"), "{waiting}");
        cfg.meetings_transcription_consent = Some(Consent {
            provider: "mistral".into(),
            host: "api.mistral.ai".into(),
        });
        assert_eq!(transcription_allowed(&cfg), Ok(()));
        // Another host needs consent again.
        cfg.meetings_audio_endpoint = "https://eu.mistral.example/v1/audio/transcriptions".into();
        assert!(transcription_allowed(&cfg).is_err());
        // A server on this computer needs none.
        cfg.switch_meeting_provider("custom");
        cfg.meetings_audio_endpoint = "http://127.0.0.1:1234/v1/audio/transcriptions".into();
        assert_eq!(transcription_allowed(&cfg), Ok(()));
    }
}
