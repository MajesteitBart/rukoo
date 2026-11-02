//! The screen process's control port: the recorder's line protocol (`voice/RECORDING.md`, "The
//! control port") on `127.0.0.1`, one JSON object per line, each request carrying the token.
//!
//! Commands: `status`, `monitors`, `monitor { id }`, `pause`, `resume`, `stop`.

use std::io;
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::Value;

pub const MAX_CONNECTIONS: usize = 8;
/// A connection that sends no complete request within this time is closed.
pub const FIRST_REQUEST: Duration = Duration::from_secs(5);
/// The longest request line, in bytes.
pub const MAX_LINE: usize = 64 * 1024;

/// 32 random bytes, base64url without padding.
pub fn new_token() -> io::Result<String> {
    todo!()
}

/// `127.0.0.1:0`.
pub fn bind() -> io::Result<TcpListener> {
    todo!()
}

/// A request with a good token, for the process's main loop. The answer goes back on `reply`.
#[derive(Debug)]
pub struct Request {
    pub body: Value,
    pub reply: mpsc::Sender<Value>,
}

/// Serves the port on its own thread: checks the token and the limits, answers bad requests
/// itself and hands the rest to `to_main`.
pub fn serve(
    listener: TcpListener,
    token: String,
    to_main: mpsc::SyncSender<Request>,
) -> io::Result<JoinHandle<()>> {
    let _ = (listener, token, to_main);
    todo!()
}

/// Sends one request and reads its answer.
pub fn request(port: u16, token: &str, body: Value, timeout: Duration) -> io::Result<Value> {
    let _ = (port, token, body, timeout);
    todo!()
}
