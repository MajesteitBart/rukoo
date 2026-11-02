//! The encryption format `RKV1` (spec 2.5): a 115-byte header, then XChaCha20-Poly1305 chunks of
//! 64 KiB with STREAM-BE32 style nonces under a random per-object data key (DEK).

use std::io::{Read, Seek};

use zeroize::Zeroizing;

use crate::keys::MasterKey;
use crate::SyncError;

pub const HEADER_LEN: u64 = 115;
pub const CHUNK: u64 = 65_536;
pub const TAG: u64 = 16;

/// `115 + len + 16·max(1, ceil(len / 65536))`.
pub fn cipher_len(plain_len: u64) -> u64 {
    let _ = plain_len;
    todo!()
}

/// The ciphertext bytes [from, to) that hold plaintext [a, b).
pub fn cipher_range(plain_len: u64, a: u64, b: u64) -> (u64, u64) {
    let _ = (plain_len, a, b);
    todo!()
}

/// The 115-byte header of 2.5.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Header {
    version: u8,
    algorithm: u8,
    chunk_log2: u8,
    kid: [u8; 8],
    plain_len: u64,
    prefix: [u8; 19],
    wrap_nonce: [u8; 24],
    wrapped_dek: [u8; 48],
}

impl Header {
    pub fn parse(bytes: &[u8]) -> Result<Header, SyncError> {
        let _ = bytes;
        todo!()
    }

    pub fn to_bytes(&self) -> [u8; 115] {
        let _ = (
            self.version,
            self.algorithm,
            self.chunk_log2,
            &self.kid,
            &self.prefix,
            &self.wrap_nonce,
            &self.wrapped_dek,
        );
        todo!()
    }

    pub fn kid_hex(&self) -> String {
        todo!()
    }

    pub fn plain_len(&self) -> u64 {
        self.plain_len
    }
}

/// Encrypts and decrypts one object: its DEK (zeroized on drop) and its stream nonce prefix.
pub struct Sealer {
    dek: Zeroizing<[u8; 32]>,
    prefix: [u8; 19],
}

impl Sealer {
    /// A new object: a fresh DEK, prefix and wrap nonce.
    pub fn new(
        key: &MasterKey,
        object: &str,
        plain_len: u64,
    ) -> Result<(Header, Sealer), SyncError> {
        let _ = (key, object, plain_len);
        todo!()
    }

    /// The same object again, from its stored header, for retries and resumed uploads.
    pub fn open(key: &MasterKey, object: &str, header: &Header) -> Result<Sealer, SyncError> {
        let _ = (key, object, header);
        todo!()
    }

    #[doc(hidden)]
    pub fn with_material(
        key: &MasterKey,
        object: &str,
        plain_len: u64,
        dek: [u8; 32],
        prefix: [u8; 19],
        wrap_nonce: [u8; 24],
    ) -> (Header, Sealer) {
        let _ = (key, object, plain_len, dek, prefix, wrap_nonce);
        todo!()
    }

    /// Ciphertext bytes [offset, offset + len) of the whole object, header included, reading only
    /// the plaintext chunks they need.
    pub fn read_cipher(
        &self,
        header: &Header,
        plain: &mut (impl Read + Seek),
        offset: u64,
        len: usize,
    ) -> Result<Vec<u8>, SyncError> {
        let _ = (&self.dek, &self.prefix, header, plain, offset, len);
        todo!()
    }

    /// The plaintext of chunk `index` from its ciphertext (65,552 bytes, or fewer for the last).
    pub fn open_chunk(
        &self,
        header: &Header,
        index: u64,
        cipher: &[u8],
    ) -> Result<Vec<u8>, SyncError> {
        let _ = (header, index, cipher);
        todo!()
    }
}
