//! What can go wrong while syncing, and the codes Settings shows for it.

use std::fmt;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncErrorKind {
    Endpoint,
    Network,
    Timeout,
    Auth,
    Bucket,
    Permission,
    Clock,
    Throttled,
    Server,
    NoSuchUpload,
    NotFound,
    NoSecret,
    Off,
    Key,
    KeyInUse,
    NotInBucket,
    Crypto,
    Local,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncError {
    pub kind: SyncErrorKind,
    /// English, for logs and Error details. Never holds the secret or a signed URL.
    pub message: String,
}

impl SyncError {
    pub fn new(kind: SyncErrorKind, message: impl Into<String>) -> SyncError {
        SyncError {
            kind,
            message: message.into(),
        }
    }

    /// The code Settings maps to text: endpoint, network, auth, bucket, clock, permission,
    /// no_secret, key, key_in_use, off or failed.
    pub fn code(&self) -> &'static str {
        todo!()
    }

    /// Whether waiting and trying again can help: network, timeout, throttled, server.
    pub fn transient(&self) -> bool {
        todo!()
    }
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SyncError {}
