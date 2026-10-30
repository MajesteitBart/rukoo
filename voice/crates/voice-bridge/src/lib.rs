//! The bridge from Rukoo Voice to Rukoo, as `voice/PROTOCOL.md` describes it: the event log in
//! `bridge.db`, the discovery file and the WebSocket server.
//!
//! The app opens the [`EventLog`], implements [`MeetingControl`] and starts the server:
//!
//! ```no_run
//! # use std::sync::Arc;
//! # use voice_bridge::{BridgeServer, EventLog, MeetingControl};
//! # fn run(data_dir: &std::path::Path, control: Arc<dyn MeetingControl>) -> std::io::Result<()> {
//! let log = EventLog::open(data_dir).expect("bridge.db opens");
//! let path = voice_protocol::paths::bridge_path_here(voice_protocol::Side::Voice).unwrap();
//! let bridge = BridgeServer::start(log.clone(), control, &path, "0.1.0")?;
//! // ... record meetings, append events to `log` ...
//! bridge.shutdown();
//! # Ok(()) }
//! ```

mod discovery;
mod log;
mod server;

use std::fmt;

use serde_json::Value;

pub use discovery::Discovery;
pub use log::{EventLog, LogError, Stored, DB_FILE};
pub use server::{BridgeServer, Handle, Options};
pub use voice_protocol::{ErrorCode, MeetingSummary, StartArgs, Status};

/// What the bridge asks of the app when Rukoo sends a command.
///
/// The server calls these from a blocking thread, one command at a time per connection, so an
/// implementation may block on the recorder or the disk. Ids are meeting ids that passed the
/// protocol checks. The events a command causes go through the [`EventLog`]; they may reach
/// Rukoo before the reply.
pub trait MeetingControl: Send + Sync {
    /// `meeting.start` from Rukoo: start recording with `startedBy` `rukoo`. Returns the new
    /// meeting's id, or `busy` with the meeting that already records.
    fn start(&self, args: StartArgs) -> Result<String, ControlError>;

    /// `meeting.stop` from Rukoo, which ends the meeting with the reason `rukoo`.
    fn stop(&self, id: &str) -> Result<(), ControlError>;

    fn pause(&self, id: &str) -> Result<(), ControlError>;

    /// `not_recording` unless the meeting is paused.
    fn resume(&self, id: &str) -> Result<(), ControlError>;

    /// Adds a user mark. Returns the mark's id and its meeting time.
    fn mark(&self, id: &str, label: Option<&str>) -> Result<(String, u64), ControlError>;

    /// The newest meetings first, at most `limit` of them.
    fn list(&self, limit: usize) -> Vec<MeetingSummary>;

    /// The snapshot of `meeting.get`: `{ meeting, speakers, passages, marks, head }`, where
    /// `head` is the log's sequence number the snapshot is complete up to.
    fn get(&self, id: &str) -> Result<Value, ControlError>;

    /// The result of `frame.get`: `{ frame, image }`. Voice 0.1 answers `not_available`.
    fn frame(&self, id: &str, at: u64) -> Result<Value, ControlError>;

    fn status(&self) -> Status;
}

/// A command that failed, with one of the error codes of PROTOCOL.md.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlError {
    pub code: ErrorCode,
    /// English, for logs. Rukoo shows its own text for the code.
    pub message: String,
    /// For `busy`: the meeting that is recording.
    pub meeting: Option<String>,
}

impl ControlError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> ControlError {
        ControlError {
            code,
            message: message.into(),
            meeting: None,
        }
    }

    pub fn not_found(message: impl Into<String>) -> ControlError {
        ControlError::new(ErrorCode::NotFound, message)
    }

    pub fn not_recording(message: impl Into<String>) -> ControlError {
        ControlError::new(ErrorCode::NotRecording, message)
    }

    /// A meeting is already recording: `meeting`.
    pub fn busy(meeting: impl Into<String>, message: impl Into<String>) -> ControlError {
        ControlError {
            meeting: Some(meeting.into()),
            ..ControlError::new(ErrorCode::Busy, message)
        }
    }

    pub fn not_available(message: impl Into<String>) -> ControlError {
        ControlError::new(ErrorCode::NotAvailable, message)
    }

    pub fn failed(message: impl Into<String>) -> ControlError {
        ControlError::new(ErrorCode::Failed, message)
    }
}

impl fmt::Display for ControlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ControlError {}
