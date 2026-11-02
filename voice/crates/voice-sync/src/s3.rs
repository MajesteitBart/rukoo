//! The S3 calls sync needs, presigned with rusty-s3 and sent with ureq (spec 4.2, D16).
//!
//! Requests are presigned for 15 minutes. A PUT carries `Content-Type: application/octet-stream`
//! and no other header of its own. Error messages never contain the secret or a signed URL.

use std::time::Duration;

use crate::{SyncConfig, SyncError};

pub struct Bucket {
    bucket: rusty_s3::Bucket,
    credentials: rusty_s3::Credentials,
    agent: ureq::Agent,
    prefix: String,
}

/// One uploaded part of a multipart upload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Part {
    pub number: u16,
    pub etag: String,
    pub size: u64,
}

/// A listing: keys with their sizes, and the common prefixes of a delimited listing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Listing {
    pub keys: Vec<(String, u64)>,
    pub prefixes: Vec<String>,
}

impl Bucket {
    pub fn new(
        cfg: &SyncConfig,
        secret: &str,
        connect: Duration,
        request: Duration,
    ) -> Result<Bucket, SyncError> {
        let _ = (cfg, secret, connect, request);
        todo!()
    }

    pub fn put(&self, key: &str, body: &[u8]) -> Result<(), SyncError> {
        let _ = (
            &self.bucket,
            &self.credentials,
            &self.agent,
            &self.prefix,
            key,
            body,
        );
        todo!()
    }

    /// `range` is inclusive, like HTTP's.
    pub fn get(&self, key: &str, range: Option<(u64, u64)>) -> Result<Vec<u8>, SyncError> {
        let _ = (key, range);
        todo!()
    }

    pub fn head(&self, key: &str) -> Result<Option<u64>, SyncError> {
        let _ = key;
        todo!()
    }

    pub fn delete(&self, key: &str) -> Result<(), SyncError> {
        let _ = key;
        todo!()
    }

    /// Batches of 1,000; returns the keys that failed.
    pub fn delete_many(&self, keys: &[String]) -> Result<Vec<String>, SyncError> {
        let _ = keys;
        todo!()
    }

    /// Follows continuation tokens.
    pub fn list(&self, prefix: &str, delimiter: Option<&str>) -> Result<Listing, SyncError> {
        let _ = (prefix, delimiter);
        todo!()
    }

    pub fn create_multipart(&self, key: &str) -> Result<String, SyncError> {
        let _ = key;
        todo!()
    }

    pub fn upload_part(
        &self,
        key: &str,
        upload_id: &str,
        number: u16,
        body: &[u8],
    ) -> Result<String, SyncError> {
        let _ = (key, upload_id, number, body);
        todo!()
    }

    pub fn list_parts(&self, key: &str, upload_id: &str) -> Result<Vec<Part>, SyncError> {
        let _ = (key, upload_id);
        todo!()
    }

    pub fn complete_multipart(
        &self,
        key: &str,
        upload_id: &str,
        etags: &[String],
    ) -> Result<(), SyncError> {
        let _ = (key, upload_id, etags);
        todo!()
    }

    pub fn abort_multipart(&self, key: &str, upload_id: &str) -> Result<(), SyncError> {
        let _ = (key, upload_id);
        todo!()
    }

    /// Test connection: PUT a probe, GET and compare it, list the prefix, create and abort a
    /// multipart upload, DELETE the probe. The error names the step that failed. Returns how many
    /// other kids sit under `rkv1/`.
    pub fn probe(&self, own_kid: Option<&str>) -> Result<u32, SyncError> {
        let _ = own_kid;
        todo!()
    }
}
