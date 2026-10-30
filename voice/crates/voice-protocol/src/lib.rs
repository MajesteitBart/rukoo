//! The bridge between Rukoo Voice and Rukoo, as `voice/PROTOCOL.md` describes it.
//!
//! The message types serialize to the wire format. Parse what a peer sent with
//! [`validate_incoming`]: it applies the rules of "Checking messages" and builds the typed
//! message. The serde `Deserialize` impls on the data types skip those rules, so use them only
//! for data that was already checked.

mod handshake;
mod ids;
mod message;
pub mod paths;
mod validate;

use std::fmt;
use std::time::Duration;

pub use handshake::{negotiate, replay_plan};
pub use ids::{
    is_instance, is_meeting_id, is_token, new_instance, new_token, passage_id, MeetingId,
};
pub use message::*;
pub use paths::Platform;
pub use validate::{validate_discovery, validate_incoming, Invalid};

/// The newest protocol version this crate speaks.
pub const PROTOCOL: u32 = 1;
/// The oldest protocol version this crate speaks.
pub const MIN_PROTOCOL: u32 = 1;

/// The WebSocket path on `127.0.0.1:<port>`.
pub const BRIDGE_PATH: &str = "/bridge";
/// The largest message Rukoo may send, in bytes.
pub const MAX_RUKOO_MESSAGE: usize = 1 << 20;
/// The largest message Voice may send, in bytes.
pub const MAX_VOICE_MESSAGE: usize = 8 << 20;
/// Voice serves at most this many clients at once.
pub const MAX_CLIENTS: usize = 4;
/// Rukoo sends `hello` within this time after connecting.
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// Voice pings every connection this often.
pub const PING_INTERVAL: Duration = Duration::from_secs(20);
/// Voice closes a connection that doesn't answer a ping within this time.
pub const PONG_TIMEOUT: Duration = Duration::from_secs(20);
/// `meeting.list` returns this many meetings when `limit` is left out.
pub const DEFAULT_LIST_LIMIT: u64 = 50;
/// The longest `title` `meeting.start` accepts, in characters.
pub const MAX_TITLE_CHARS: usize = 200;
/// The largest `context` `meeting.start` accepts, in bytes of compact JSON.
pub const MAX_CONTEXT_BYTES: usize = 16 * 1024;
/// The longest command id and `client` name, in characters.
pub const MAX_ID_CHARS: usize = 64;

/// WebSocket close codes from "Connecting".
pub mod close {
    /// Voice is quitting.
    pub const QUITTING: u16 = 1001;
    /// The token is wrong.
    pub const BAD_TOKEN: u16 = 4001;
    /// Voice doesn't speak the requested version.
    pub const UNSUPPORTED_PROTOCOL: u16 = 4002;
    /// No `hello` within 5 seconds, or another message first.
    pub const HELLO_TIMEOUT: u16 = 4003;
    /// Four clients are already connected.
    pub const TOO_MANY_CLIENTS: u16 = 4004;
}

/// One end of the bridge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Side {
    Voice,
    Rukoo,
}

impl Side {
    /// Reads the names the fixtures use: `voice` and `rukoo`.
    pub fn parse(name: &str) -> Option<Side> {
        match name {
            "voice" => Some(Side::Voice),
            "rukoo" => Some(Side::Rukoo),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Side::Voice => "voice",
            Side::Rukoo => "rukoo",
        }
    }
}

impl fmt::Display for Side {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
