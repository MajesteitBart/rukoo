//! The master key and the bucket secret in `<data>/sync` (spec 2.3, 2.4).

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::protect::Protector;
use crate::SyncError;

/// The DPAPI-protected master key: "RKVK", version 1, the blob.
pub const MASTER_KEY_FILE: &str = "master-key.bin";
/// The key's id and dates, no secret: [`KeyFile`].
pub const KEY_FILE: &str = "key.json";
/// The DPAPI-protected bucket secret: "RKVS", version 1, the blob.
pub const SECRET_FILE: &str = "bucket-secret.bin";

/// Zeroized on drop; its Debug prints only the kid.
pub struct MasterKey([u8; 32]);

impl MasterKey {
    /// 32 bytes from `getrandom::fill`.
    pub fn generate() -> Result<MasterKey, SyncError> {
        todo!()
    }

    pub fn from_bytes(bytes: [u8; 32]) -> MasterKey {
        MasterKey(bytes)
    }

    /// 16 hex characters: `hex(HMAC(MK, "rukoo-voice/kid/v1"))[0..16]`.
    pub fn kid(&self) -> String {
        todo!()
    }

    /// `HMAC(MK, "rukoo-voice/names/v1")`.
    pub fn name_key(&self) -> [u8; 32] {
        todo!()
    }

    /// `HMAC(MK, "rukoo-voice/wrap/v1")`.
    pub fn wrap_key(&self) -> [u8; 32] {
        todo!()
    }
}

impl Drop for MasterKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl fmt::Debug for MasterKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("MasterKey").field(&self.kid()).finish()
    }
}

/// `key.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFile {
    pub kid: String,
    pub created_at: u64,
    pub exported_at: Option<u64>,
}

/// <data>/sync: master-key.bin, key.json, bucket-secret.bin.
pub struct KeyStore {
    dir: PathBuf,
    protector: Arc<dyn Protector>,
}

impl KeyStore {
    pub fn new(sync_dir: &Path, protector: Arc<dyn Protector>) -> KeyStore {
        KeyStore {
            dir: sync_dir.to_path_buf(),
            protector,
        }
    }

    /// Ok(None) without a key; Err(Key) when DPAPI refuses the file.
    pub fn load(&self) -> Result<Option<MasterKey>, SyncError> {
        let _ = (&self.dir, &self.protector);
        todo!()
    }

    pub fn create(&self, now: u64) -> Result<MasterKey, SyncError> {
        let _ = now;
        todo!()
    }

    pub fn replace(&self, key: &MasterKey, now: u64) -> Result<(), SyncError> {
        let _ = (key, now);
        todo!()
    }

    pub fn info(&self) -> Option<KeyFile> {
        todo!()
    }

    pub fn mark_exported(&self, at: u64) -> Result<(), SyncError> {
        let _ = at;
        todo!()
    }

    pub fn save_secret(&self, secret: &str) -> Result<(), SyncError> {
        let _ = secret;
        todo!()
    }

    pub fn secret(&self) -> Result<Option<Zeroizing<String>>, SyncError> {
        todo!()
    }

    pub fn remove_secret(&self) -> Result<(), SyncError> {
        todo!()
    }
}
