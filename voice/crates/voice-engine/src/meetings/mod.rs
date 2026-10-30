//! Meetings: the recorder controller, the bridge for Rukoo and the timeline followers.

pub mod bridge;
pub mod controller;
pub mod pipeline;
pub mod tap;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::json;
use voice_bridge::EventLog;
use voice_core::config::Config;
use voice_core::consent::ConsentState;

use self::bridge::{Bridge, Control, Presence};
use self::controller::Controller;
use self::pipeline::{Library, Pipeline, PipelineHandle, PipelineOptions};
use crate::services::{AudioSink, MicStream};

pub struct Meetings {
    pub controller: Arc<Controller>,
    pub log: Option<EventLog>,
    pub bridge: Option<Bridge>,
    dictating: Arc<AtomicBool>,
    followers: Mutex<Vec<PipelineHandle>>,
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
                    dictating: Arc::clone(&dictating),
                    presence: Arc::new(Presence::default()),
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
            followers: Mutex::new(Vec::new()),
            published: Mutex::new(None),
        }
    }

    pub fn library(&self) -> &Library {
        self.controller.library()
    }

    pub fn rukoo_connected(&self) -> bool {
        self.bridge
            .as_ref()
            .is_some_and(|b| b.presence().connected())
    }

    /// Follows a meeting's timeline for Rukoo, once per meeting.
    pub fn follow(&self, id: &str, consent: PipelineOptions) {
        let Some(log) = &self.log else {
            return;
        };
        let Some(dir) = self.library().dir(id) else {
            return;
        };
        let mut followers = self
            .followers
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        followers.retain(|f| f.state() == pipeline::PipelineState::Following);
        if followers.iter().any(|f| f.id() == id) {
            return;
        }
        followers.push(Pipeline::start(dir, log.clone(), consent));
    }

    /// Emits what's missing for meetings that stopped while nothing followed them.
    pub fn catch_up(&self) {
        if let Some(log) = &self.log {
            pipeline::catch_up_stopped(self.library(), log);
        }
    }

    pub fn set_dictating(&self, on: bool) {
        self.dictating.store(on, Ordering::SeqCst);
        self.publish_status();
    }

    pub fn dictating(&self) -> bool {
        self.dictating.load(Ordering::SeqCst)
    }

    /// A `status` event when what Voice is doing changed.
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

    pub fn shutdown(&self) {
        let followers = std::mem::take(
            &mut *self
                .followers
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        );
        for follower in followers {
            follower.shutdown();
        }
        self.controller.shutdown();
        if let Some(bridge) = &self.bridge {
            bridge.stop();
        }
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
