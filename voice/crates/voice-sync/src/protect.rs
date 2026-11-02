//! Bytes only this Windows user can read: the master key and the bucket secret (spec 2.3, D4).

use std::path::Path;
use std::sync::Arc;

use zeroize::Zeroizing;

use crate::SyncError;

/// Magic of `master-key.bin`.
pub const MASTER_KEY_MAGIC: &[u8; 4] = b"RKVK";
/// Magic of `bucket-secret.bin`.
pub const SECRET_MAGIC: &[u8; 4] = b"RKVS";
/// DPAPI entropy of the master key.
pub const MASTER_KEY_LABEL: &str = "rukoo-voice/master-key/v1";
/// DPAPI entropy of the bucket secret.
pub const SECRET_LABEL: &str = "rukoo-voice/bucket-secret/v1";

/// Keeps bytes readable only by this Windows user (DPAPI), or a stand-in in tests.
pub trait Protector: Send + Sync {
    fn protect(&self, plain: &[u8], label: &str) -> Result<Vec<u8>, SyncError>;
    fn unprotect(&self, blob: &[u8], label: &str) -> Result<Zeroizing<Vec<u8>>, SyncError>;
}

/// CryptProtectData / CryptUnprotectData (windows-0.62.2 Security/Cryptography/mod.rs:1659,1872)
/// with CRYPTPROTECT_UI_FORBIDDEN (:8271), the label as entropy, and LocalFree on the output
/// (Win32/Foundation/mod.rs:38). CryptUnprotectData's output is zeroed before LocalFree, which
/// frees without clearing; the copy it returns is Zeroizing.
#[cfg(windows)]
pub struct Dpapi;

#[cfg(windows)]
impl Protector for Dpapi {
    fn protect(&self, plain: &[u8], label: &str) -> Result<Vec<u8>, SyncError> {
        let _ = (plain, label);
        todo!()
    }

    fn unprotect(&self, blob: &[u8], label: &str) -> Result<Zeroizing<Vec<u8>>, SyncError> {
        let _ = (blob, label);
        todo!()
    }
}

/// For tests on every platform: XORs with a stream derived from the label and adds a marker, so a
/// test can tell a protected blob from plain bytes. Used only by tests and the fake engine.
pub struct TestProtector;

impl Protector for TestProtector {
    fn protect(&self, plain: &[u8], label: &str) -> Result<Vec<u8>, SyncError> {
        let _ = (plain, label);
        todo!()
    }

    fn unprotect(&self, blob: &[u8], label: &str) -> Result<Zeroizing<Vec<u8>>, SyncError> {
        let _ = (blob, label);
        todo!()
    }
}

/// Dpapi on Windows; elsewhere a protector that refuses ("Bucket sync needs Windows.").
pub fn system() -> Arc<dyn Protector> {
    todo!()
}

/// `RKVK` / `RKVS` files (2.3), written to a temporary name and renamed.
pub fn read_protected(
    path: &Path,
    magic: &[u8; 4],
    label: &str,
    p: &dyn Protector,
) -> Result<Option<Zeroizing<Vec<u8>>>, SyncError> {
    let _ = (path, magic, label, p);
    todo!()
}

pub fn write_protected(
    path: &Path,
    magic: &[u8; 4],
    label: &str,
    plain: &[u8],
    p: &dyn Protector,
) -> Result<(), SyncError> {
    let _ = (path, magic, label, plain, p);
    todo!()
}
