//! The `sync-worker` thread (spec 2.8, 2.9): scans, the queue's next row, one request at a time,
//! the live lane's token bucket, backoff, manifests and the index. Every loop catches panics, logs
//! them and starts again after 5 s.

use crate::sync::SyncOptions;

/// What the facade and the worker share.
#[allow(dead_code)] // Built by BucketSync::open.
pub(crate) struct Shared {
    pub(crate) opts: SyncOptions,
}
