//! A small S3-compatible server with fault injection, for Rukoo Voice's sync tests and the live
//! paired run. std only; it never ships.
//!
//! It answers path-style and virtual-host requests for one bucket, checks the access key in
//! `X-Amz-Credential` and the expiry from `X-Amz-Date` plus `X-Amz-Expires` (403 `AccessDenied`
//! "Request has expired" afterwards), and doesn't verify signatures. XML bodies follow the S3 API
//! for the calls in [`Op`]. ETags are `"<length hex>-<FNV-1a 64 hex>"`.

use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

/// A TcpListener on 127.0.0.1, a thread per connection, the store, the log and the faults.
pub struct FakeS3 {
    addr: SocketAddr,
    faults: Arc<Mutex<Faults>>,
    log: Arc<Mutex<Vec<Logged>>>,
}

/// Faults to inject. Each applies to the requests that arrive after it was set.
#[derive(Debug, Default)]
pub struct Faults {
    /// The next matching requests answer this status and S3 code.
    pub fail: Vec<(Op, u16, &'static str)>,
    /// Hold every answer this long.
    pub stall: Option<Duration>,
    /// Close the socket after this many body bytes of the next upload.
    pub drop_after: Option<u64>,
    /// Close every connection at once.
    pub refuse: bool,
    /// Refuse unequal non-last parts, as R2 does (InvalidPart).
    pub r2_parts: bool,
    /// NoSuchUpload for every open upload id.
    pub forget_uploads: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Put,
    Get,
    Head,
    Delete,
    DeleteMany,
    List,
    Create,
    UploadPart,
    ListParts,
    Complete,
    Abort,
}

/// One answered request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Logged {
    pub op: Op,
    pub key: String,
    pub part: Option<u16>,
    /// Body bytes received for uploads, sent for downloads.
    pub bytes: u64,
    pub status: u16,
    /// Wall ms since the epoch when the answer went out.
    pub at: u64,
}

impl FakeS3 {
    /// On a free port. `dir`: keep objects on disk, so another process sees them after a restart,
    /// in the layout `src/main.rs` describes.
    pub fn start(bucket: &str, access_key: &str, dir: Option<PathBuf>) -> io::Result<FakeS3> {
        FakeS3::start_on(0, bucket, access_key, dir)
    }

    /// On `port` of 127.0.0.1 (0 for a free one), so a restarted fake keeps its endpoint.
    pub fn start_on(
        port: u16,
        bucket: &str,
        access_key: &str,
        dir: Option<PathBuf>,
    ) -> io::Result<FakeS3> {
        let _ = (port, bucket, access_key, dir);
        todo!()
    }

    /// `http://127.0.0.1:<port>`.
    pub fn endpoint(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn faults(&self) -> MutexGuard<'_, Faults> {
        self.faults.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn log(&self) -> Vec<Logged> {
        self.log
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Keys and raw stored bytes.
    pub fn objects(&self) -> Vec<(String, Vec<u8>)> {
        todo!()
    }

    pub fn stop(self) {
        todo!()
    }
}
