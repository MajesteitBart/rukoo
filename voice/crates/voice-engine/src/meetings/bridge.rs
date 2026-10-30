//! Hosts the bridge for Rukoo (voice/PROTOCOL.md): the server, `MeetingControl` over the
//! controller, and the `status` events.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::Value;
use voice_bridge::{BridgeServer, ControlError, EventLog, Handle, MeetingControl};
use voice_protocol::{MeetingId, MeetingSummary, StartArgs, StartedBy, Status};

use super::controller::Controller;

/// Rukoo asks `status.get` every 30 s and on every connect, so a call within this time means a
/// Rukoo is connected. voice-bridge doesn't report its clients yet; this is the engine's best
/// guess until it does.
const PRESENCE: Duration = Duration::from_secs(70);

#[derive(Default)]
pub struct Presence {
    last: Mutex<Option<Instant>>,
}

impl Presence {
    fn seen(&self) {
        *self.last.lock().unwrap_or_else(PoisonError::into_inner) = Some(Instant::now());
    }

    pub fn connected(&self) -> bool {
        self.last
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some_and(|at| at.elapsed() < PRESENCE)
    }
}

/// What Rukoo's commands do.
pub struct Control {
    pub controller: Arc<Controller>,
    pub dictating: Arc<AtomicBool>,
    pub presence: Arc<Presence>,
}

impl Control {
    pub fn status(&self) -> Status {
        Status {
            recording: self
                .controller
                .current()
                .and_then(|r| MeetingId::parse(&r.id)),
            dictating: self.dictating.load(Ordering::SeqCst),
        }
    }
}

impl MeetingControl for Control {
    fn start(&self, args: StartArgs) -> Result<String, ControlError> {
        self.controller.start(args, StartedBy::Rukoo)
    }

    fn stop(&self, id: &str) -> Result<(), ControlError> {
        self.controller.stop(Some(id), "rukoo")
    }

    fn pause(&self, id: &str) -> Result<(), ControlError> {
        self.controller.pause(Some(id))
    }

    fn resume(&self, id: &str) -> Result<(), ControlError> {
        self.controller.resume(Some(id))
    }

    fn mark(&self, id: &str, label: Option<&str>) -> Result<(String, u64), ControlError> {
        self.controller.mark(Some(id), label)
    }

    fn list(&self, limit: usize) -> Vec<MeetingSummary> {
        self.controller.library().list(limit)
    }

    fn get(&self, id: &str) -> Result<Value, ControlError> {
        if self.controller.library().dir(id).is_none() {
            return Err(ControlError::not_found("There is no meeting with that id."));
        }
        // WAVE 2: transcripts come with voice_meetings::Library::get.
        Err(ControlError::not_available(
            "This build of Voice records meetings but doesn't transcribe them yet.",
        ))
    }

    fn frame(&self, id: &str, _at: u64) -> Result<Value, ControlError> {
        if self.controller.library().dir(id).is_none() {
            return Err(ControlError::not_found("There is no meeting with that id."));
        }
        Err(ControlError::not_available(
            "Voice 0.1 doesn't record the screen.",
        ))
    }

    fn status(&self) -> Status {
        self.presence.seen();
        Control::status(self)
    }
}

/// The running server, which a new token replaces.
pub struct Bridge {
    log: EventLog,
    control: Arc<Control>,
    path: PathBuf,
    version: String,
    handle: Mutex<Option<Handle>>,
    error: Mutex<Option<String>>,
}

impl Bridge {
    pub fn start(log: EventLog, control: Arc<Control>, path: PathBuf, version: &str) -> Bridge {
        let bridge = Bridge {
            log,
            control,
            path,
            version: version.to_string(),
            handle: Mutex::new(None),
            error: Mutex::new(None),
        };
        let _ = bridge.listen();
        bridge
    }

    fn listen(&self) -> io::Result<()> {
        let control: Arc<dyn MeetingControl> = self.control.clone();
        let result = BridgeServer::start(self.log.clone(), control, &self.path, &self.version);
        let mut handle = self.handle.lock().unwrap_or_else(PoisonError::into_inner);
        let mut error = self.error.lock().unwrap_or_else(PoisonError::into_inner);
        match result {
            Ok(started) => {
                *handle = Some(started);
                *error = None;
                Ok(())
            }
            Err(e) => {
                *error = Some(e.to_string());
                Err(e)
            }
        }
    }

    pub fn port(&self) -> Option<u16> {
        self.handle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(Handle::port)
    }

    pub fn discovery_path(&self) -> &Path {
        &self.path
    }

    pub fn presence(&self) -> &Presence {
        &self.control.presence
    }

    /// A new token: the server restarts, which writes a new discovery file and closes every
    /// client; Rukoo reconnects with the new file (PROTOCOL.md, Connecting).
    pub fn new_token(&self) -> io::Result<()> {
        self.stop();
        self.listen()
    }

    pub fn stop(&self) {
        let handle = self
            .handle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(handle) = handle {
            handle.shutdown();
        }
    }
}
