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
use std::time::Instant;

use serde_json::Value;

pub use discovery::Discovery;
pub use log::{EventLog, LogError, Stored, DB_FILE};
pub use server::{BridgeServer, Client, Clients, Handle, Options, Refused};
pub use voice_protocol::{
    split_reasons, sync_reasons, ErrorCode, MediaKind, MediaOpenArgs, MeetingSummary, SplitResult,
    StartArgs, Status, SyncSettings, Track,
};

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

    fn delete(&self, _id: &str) -> Result<(), ControlError> {
        Err(ControlError::not_available(
            "This Voice cannot delete meetings.",
        ))
    }

    fn pause(&self, id: &str) -> Result<(), ControlError>;

    /// `not_recording` unless the meeting is paused.
    fn resume(&self, id: &str) -> Result<(), ControlError>;

    /// Adds a user mark. Returns the mark's id and its meeting time.
    fn mark(&self, id: &str, label: Option<&str>) -> Result<(String, u64), ControlError>;

    /// The newest meetings first, at most `limit` of them.
    fn list(&self, limit: usize) -> Vec<MeetingSummary>;

    /// The snapshot of `meeting.get`: `{ meeting, speakers, passages, marks, frames, head }`,
    /// where `head` is the log's sequence number the snapshot is complete up to. Older frames
    /// may carry `"text": ""` and `"textOmitted": true` to keep the reply under the size limit.
    fn get(&self, id: &str) -> Result<Value, ControlError>;

    /// The result of `frame.get`: `{ frame, image }` for the frame at or before `at`.
    fn frame(&self, id: &str, at: u64) -> Result<Value, ControlError>;

    /// The result of `clip.get`: `{ clips: [...] }` with the clips cut by `deadline`, which is
    /// [`CLIP_WAIT`](voice_protocol::CLIP_WAIT) after the server read the command. It answers
    /// by then and lets a longer cut go on, because the connection's later commands wait for it.
    fn clip(
        &self,
        id: &str,
        start: u64,
        end: u64,
        deadline: Instant,
    ) -> Result<Value, ControlError> {
        let _ = (id, start, end, deadline);
        Err(ControlError::not_available("This Voice doesn't cut clips."))
    }

    /// `meeting.protected`: a Rukoo hid its windows after `meeting.starting`.
    fn protected(&self, id: &str) -> Result<(), ControlError> {
        let _ = id;
        Ok(())
    }

    /// A protection ack must stay nonblocking: the bridge handles it ahead of queued commands.
    fn protected_for(
        &self,
        id: &str,
        _request: Option<&str>,
        _connection: u64,
    ) -> Result<(), ControlError> {
        self.protected(id)
    }

    fn set_screen(
        &self,
        _id: &str,
        _mode: voice_protocol::ScreenMode,
        _monitor: Option<&str>,
        _deadline: Instant,
    ) -> Result<Value, ControlError> {
        Err(ControlError::not_available(
            "This Voice cannot change screen recording.",
        ))
    }

    /// The result of `screen.get`: `{ screen, state, video, frames, monitor, monitors }`. It
    /// answers by `deadline`, as `clip`, however slow the screen recorder is to start or answer.
    fn screen(&self, id: &str, deadline: Instant) -> Result<Value, ControlError> {
        let _ = (id, deadline);
        Err(ControlError::not_available(
            "This Voice doesn't record the screen.",
        ))
    }

    /// `screen.select`: records the monitor with that id. Returns the id. It answers by
    /// `deadline`, as `clip`: `failed` when the screen recorder couldn't switch by then.
    fn select_monitor(
        &self,
        id: &str,
        monitor: &str,
        deadline: Instant,
    ) -> Result<String, ControlError> {
        let _ = (id, monitor, deadline);
        Err(ControlError::not_available(
            "This Voice doesn't record the screen.",
        ))
    }

    /// `media.open`: `{ media, ready: false }` while preparing, then `{ media, ready: true, type, size,
    /// start, end }`. Must answer quickly; prepare on another thread. The same arguments give the
    /// same `media` while the file is kept. A Voice that doesn't serve media answers
    /// `not_available`.
    fn media_open(&self, _args: &MediaOpenArgs) -> Result<Value, ControlError> {
        Err(ControlError::not_available(
            "This Voice doesn't serve meeting media.",
        ))
    }

    /// `media.read`: `{ offset, data }`, at most `length` bytes in standard base64
    /// ([`voice_protocol::media_read_result`] builds it); `data` is empty past the end. `not_found`
    /// for an unknown or forgotten id, `bad_request` for a file that isn't ready yet.
    fn media_read(&self, _media: &str, _offset: u64, _length: u64) -> Result<Value, ControlError> {
        Err(ControlError::not_found("There is no media with that id."))
    }

    /// `speakers.split`: `{ state: "running", at, end }` while Voice tells the track's voices
    /// apart, then `{ state: "done", voices }` ([`SplitResult`] builds both). Must answer quickly;
    /// split on another thread. `busy` with the meeting while it records, pauses or processes,
    /// and `not_available` with a [`split_reasons`] reason when the split can't run. A Voice that
    /// doesn't split answers `not_available`.
    fn split_speakers(&self, _id: &str, _track: Track) -> Result<Value, ControlError> {
        Err(ControlError::not_available(
            "This Voice doesn't tell apart the voices on a track.",
        ))
    }

    /// `sync.pull`: look in the bucket for meetings from the user's other computers now. Nothing
    /// happens without bucket sync.
    fn pull_meetings(&self) {}

    /// `sync.settings.get`: the bucket's settings with its secret and the recovery code, or `None`
    /// while bucket sync is off or its connection didn't pass Test connection. Never makes a key.
    /// `busy` with reason `screen` while a meeting records the screen. A Voice that doesn't share
    /// its settings answers `not_available`.
    fn sync_settings(&self) -> Result<Option<SyncSettings>, ControlError> {
        Err(ControlError::not_available(
            "This Voice doesn't share its sync settings.",
        ))
    }

    /// `sync.settings.set`: uses these settings as the user would in Settings > Storage, and
    /// leaves everything as it was when that fails. `failed` with a [`sync_reasons`] reason, or
    /// `busy` with `key_in_use`.
    fn use_sync_settings(&self, _settings: &SyncSettings) -> Result<(), ControlError> {
        Err(ControlError::not_available(
            "This Voice doesn't take sync settings from Rukoo.",
        ))
    }

    /// `meeting.data.set`: keeps what Rukoo owns of the meeting and uploads it to the user's bucket
    /// for their other computers. `not_found` for a meeting Voice doesn't have.
    fn set_data(&self, _id: &str, _data: &voice_protocol::Object) -> Result<(), ControlError> {
        Err(ControlError::not_available(
            "This Voice doesn't keep Rukoo's meeting data.",
        ))
    }

    /// `media.prefetch` with `kind` `frames`: fetch the meeting's frame images that aren't on this
    /// computer back from the bucket in the background, at low priority. Answers `{}` at once.
    fn prefetch_frames(&self, _id: &str) -> Result<Value, ControlError> {
        Err(ControlError::not_available(
            "This Voice doesn't fetch media ahead.",
        ))
    }

    /// `media.keep`: with `keep`, keep all of the meeting's media on this computer or let the
    /// cache limit apply again; either way `{ keep, have, total, stalled }` in bytes.
    fn keep_media(&self, _id: &str, _keep: Option<bool>) -> Result<Value, ControlError> {
        Err(ControlError::not_available(
            "This Voice doesn't keep media on this computer.",
        ))
    }

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
    /// Why, for an error that says more, as `speakers.split`'s `not_available` does.
    pub reason: Option<String>,
}

impl ControlError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> ControlError {
        ControlError {
            code,
            message: message.into(),
            meeting: None,
            reason: None,
        }
    }

    /// The same error with a `reason`.
    pub fn with_reason(self, reason: impl Into<String>) -> ControlError {
        ControlError {
            reason: Some(reason.into()),
            ..self
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

    /// The arguments passed the protocol checks but this Voice can't take them, such as more
    /// video than it serves at once.
    pub fn bad_request(message: impl Into<String>) -> ControlError {
        ControlError::new(ErrorCode::BadRequest, message)
    }
}

impl fmt::Display for ControlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ControlError {}
