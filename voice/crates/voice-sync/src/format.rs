//! The encryption format `RKV1` (spec 2.5): a 115-byte header, then XChaCha20-Poly1305 chunks of
//! 64 KiB with STREAM-BE32 style nonces under a random per-object data key (DEK).
//!
//! Header: `RKV1`, version 1, algorithm 1, chunk size as log2 (16), a reserved zero, the kid's 8
//! raw bytes, the plaintext length (u64 big-endian), the 19-byte stream nonce prefix, the 24-byte
//! wrap nonce, and the DEK encrypted under `wrapKey` with its tag (48 bytes). The wrap's
//! associated data is `header[0..43]` followed by the object name without `<prefix>`, so a
//! swapped, renamed or altered header fails to open.
//!
//! Chunk `i` of `n = max(1, ceil(len / 65536))` is encrypted under the DEK with the nonce
//! `prefix ‖ BE32(i) ‖ last`, `last` being 1 only for chunk `n-1`, and empty associated data.

use std::io::{self, Read, Seek, SeekFrom};

use chacha20poly1305::aead::{AeadInOut, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use zeroize::{Zeroize, Zeroizing};

use crate::keys::{random, MasterKey};
use crate::names::hex;
use crate::{SyncError, SyncErrorKind};

pub const HEADER_LEN: u64 = 115;
pub const CHUNK: u64 = 65_536;
pub const TAG: u64 = 16;

const MAGIC: &[u8; 4] = b"RKV1";
const VERSION: u8 = 1;
const ALGORITHM: u8 = 1;
const CHUNK_LOG2: u8 = 16;
/// The header bytes the wrapped DEK authenticates: everything before the wrap nonce.
const AAD_LEN: usize = 43;
const CIPHER_CHUNK: u64 = CHUNK + TAG;
/// Chunk counters are 32 bits.
const MAX_CHUNKS: u64 = 1 << 32;

/// How many chunks hold `plain_len` bytes: at least one, so an empty file has an empty last one.
fn chunk_count(plain_len: u64) -> u64 {
    plain_len.div_ceil(CHUNK).max(1)
}

/// The plaintext bytes in chunk `index`.
fn chunk_plain_len(plain_len: u64, index: u64) -> u64 {
    plain_len.saturating_sub(index * CHUNK).min(CHUNK)
}

/// `115 + len + 16·max(1, ceil(len / 65536))`.
pub fn cipher_len(plain_len: u64) -> u64 {
    HEADER_LEN + plain_len + TAG * chunk_count(plain_len)
}

/// The ciphertext bytes [from, to) that hold plaintext [a, b): whole chunks, `a >> 16` through
/// `(b-1) >> 16`. `b` is clamped to the length; an empty range gives an empty one.
pub fn cipher_range(plain_len: u64, a: u64, b: u64) -> (u64, u64) {
    let b = b.min(plain_len);
    let a = a.min(b);
    let total = cipher_len(plain_len);
    if a == b {
        let at = (HEADER_LEN + (a / CHUNK) * CIPHER_CHUNK).min(total);
        return (at, at);
    }
    let first = a / CHUNK;
    let last = (b - 1) / CHUNK;
    (
        HEADER_LEN + first * CIPHER_CHUNK,
        (HEADER_LEN + (last + 1) * CIPHER_CHUNK).min(total),
    )
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
    /// Reads the first 115 bytes, so a whole object or just its start will do.
    pub fn parse(bytes: &[u8]) -> Result<Header, SyncError> {
        let crypto = |message: &str| SyncError::new(SyncErrorKind::Crypto, message);
        if bytes.len() < HEADER_LEN as usize {
            return Err(crypto("The object is too short to be in Voice's format."));
        }
        if &bytes[0..4] != MAGIC {
            return Err(crypto("The object isn't in Voice's format."));
        }
        if bytes[4] != VERSION {
            return Err(crypto("The object was written by a newer Voice."));
        }
        if bytes[5] != ALGORITHM || bytes[6] != CHUNK_LOG2 || bytes[7] != 0 {
            return Err(crypto("The object uses settings this Voice doesn't know."));
        }
        let mut header = Header {
            version: bytes[4],
            algorithm: bytes[5],
            chunk_log2: bytes[6],
            kid: [0; 8],
            plain_len: u64::from_be_bytes(bytes[16..24].try_into().expect("8 bytes")),
            prefix: [0; 19],
            wrap_nonce: [0; 24],
            wrapped_dek: [0; 48],
        };
        if chunk_count(header.plain_len) > MAX_CHUNKS {
            return Err(crypto("The object's length is out of range."));
        }
        header.kid.copy_from_slice(&bytes[8..16]);
        header.prefix.copy_from_slice(&bytes[24..43]);
        header.wrap_nonce.copy_from_slice(&bytes[43..67]);
        header.wrapped_dek.copy_from_slice(&bytes[67..115]);
        Ok(header)
    }

    pub fn to_bytes(&self) -> [u8; 115] {
        let mut out = [0u8; 115];
        out[0..4].copy_from_slice(MAGIC);
        out[4] = self.version;
        out[5] = self.algorithm;
        out[6] = self.chunk_log2;
        out[7] = 0;
        out[8..16].copy_from_slice(&self.kid);
        out[16..24].copy_from_slice(&self.plain_len.to_be_bytes());
        out[24..43].copy_from_slice(&self.prefix);
        out[43..67].copy_from_slice(&self.wrap_nonce);
        out[67..115].copy_from_slice(&self.wrapped_dek);
        out
    }

    /// The kid as 16 hex characters, as [`MasterKey::kid`] gives it.
    pub fn kid_hex(&self) -> String {
        hex(&self.kid)
    }

    pub fn plain_len(&self) -> u64 {
        self.plain_len
    }

    /// `header[0..43] ‖ object`.
    fn wrap_aad(&self, object: &str) -> Vec<u8> {
        let mut aad = Vec::with_capacity(AAD_LEN + object.len());
        aad.extend_from_slice(&self.to_bytes()[..AAD_LEN]);
        aad.extend_from_slice(object.as_bytes());
        aad
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
        if chunk_count(plain_len) > MAX_CHUNKS {
            return Err(SyncError::new(
                SyncErrorKind::Local,
                "The file is too large to encrypt.",
            ));
        }
        let mut dek = Zeroizing::new([0u8; 32]);
        let mut prefix = [0u8; 19];
        let mut wrap_nonce = [0u8; 24];
        random(&mut dek[..])?;
        random(&mut prefix)?;
        random(&mut wrap_nonce)?;
        Ok(Sealer::seal_with(
            key, object, plain_len, dek, prefix, wrap_nonce,
        ))
    }

    /// The same object again, from its stored header, for retries and resumed uploads.
    ///
    /// `Key` when the header names another key; `Crypto` when the DEK doesn't unwrap, because
    /// the header was changed or the object has another name.
    pub fn open(key: &MasterKey, object: &str, header: &Header) -> Result<Sealer, SyncError> {
        if header.kid != key.kid_bytes() {
            return Err(SyncError::new(
                SyncErrorKind::Key,
                format!(
                    "The object was encrypted with key {}, not with this computer's key.",
                    header.kid_hex()
                ),
            ));
        }
        let wrap_key = Zeroizing::new(key.wrap_key());
        let mut buf = Zeroizing::new(header.wrapped_dek.to_vec());
        aead(&wrap_key)
            .decrypt_in_place(
                &XNonce::from(header.wrap_nonce),
                &header.wrap_aad(object),
                &mut *buf,
            )
            .map_err(|_| {
                SyncError::new(
                    SyncErrorKind::Crypto,
                    "The object's key doesn't open: the object was changed or renamed.",
                )
            })?;
        let mut dek = Zeroizing::new([0u8; 32]);
        dek.copy_from_slice(&buf);
        Ok(Sealer {
            dek,
            prefix: header.prefix,
        })
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
        let mut dek = dek;
        let sealed = Sealer::seal_with(
            key,
            object,
            plain_len,
            Zeroizing::new(dek),
            prefix,
            wrap_nonce,
        );
        dek.zeroize();
        sealed
    }

    fn seal_with(
        key: &MasterKey,
        object: &str,
        plain_len: u64,
        dek: Zeroizing<[u8; 32]>,
        prefix: [u8; 19],
        wrap_nonce: [u8; 24],
    ) -> (Header, Sealer) {
        let mut header = Header {
            version: VERSION,
            algorithm: ALGORITHM,
            chunk_log2: CHUNK_LOG2,
            kid: key.kid_bytes(),
            plain_len,
            prefix,
            wrap_nonce,
            wrapped_dek: [0; 48],
        };
        let wrap_key = Zeroizing::new(key.wrap_key());
        let mut buf = Zeroizing::new(Vec::with_capacity(48));
        buf.extend_from_slice(&dek[..]);
        aead(&wrap_key)
            .encrypt_in_place(
                &XNonce::from(wrap_nonce),
                &header.wrap_aad(object),
                &mut *buf,
            )
            .expect("XChaCha20-Poly1305 seals 32 bytes");
        header.wrapped_dek.copy_from_slice(&buf);
        (header, Sealer { dek, prefix })
    }

    /// Ciphertext bytes [offset, offset + len) of the whole object, header included, reading only
    /// the plaintext chunks they need. Clamped to the object's end. `Local` when `plain` is
    /// shorter than the header says.
    pub fn read_cipher(
        &self,
        header: &Header,
        plain: &mut (impl Read + Seek),
        offset: u64,
        len: usize,
    ) -> Result<Vec<u8>, SyncError> {
        let total = cipher_len(header.plain_len);
        let start = offset.min(total);
        let end = offset.saturating_add(len as u64).min(total);
        let mut out = Vec::with_capacity((end - start) as usize);
        if start >= end {
            return Ok(out);
        }
        if start < HEADER_LEN {
            let bytes = header.to_bytes();
            out.extend_from_slice(&bytes[start as usize..end.min(HEADER_LEN) as usize]);
        }
        if end <= HEADER_LEN {
            return Ok(out);
        }
        let body_start = start.max(HEADER_LEN) - HEADER_LEN;
        let body_end = end - HEADER_LEN;
        let n = chunk_count(header.plain_len);
        let cipher = aead(&self.dek);
        let mut buf = Zeroizing::new(Vec::with_capacity(CIPHER_CHUNK as usize));
        for index in body_start / CIPHER_CHUNK..=(body_end - 1) / CIPHER_CHUNK {
            buf.clear();
            buf.resize(chunk_plain_len(header.plain_len, index) as usize, 0);
            plain
                .seek(SeekFrom::Start(index * CHUNK))
                .and_then(|_| plain.read_exact(&mut buf[..]))
                .map_err(|e| {
                    if e.kind() == io::ErrorKind::UnexpectedEof {
                        SyncError::new(
                            SyncErrorKind::Local,
                            "The file is shorter than when it was queued.",
                        )
                    } else {
                        SyncError::new(SyncErrorKind::Local, format!("Couldn't read the file: {e}"))
                    }
                })?;
            cipher
                .encrypt_in_place(&self.nonce(index, index + 1 == n), b"", &mut *buf)
                .expect("XChaCha20-Poly1305 seals a 64 KiB chunk");
            let chunk_start = index * CIPHER_CHUNK;
            let from = body_start.max(chunk_start) - chunk_start;
            let to = body_end.min(chunk_start + buf.len() as u64) - chunk_start;
            out.extend_from_slice(&buf[from as usize..to as usize]);
        }
        Ok(out)
    }

    /// The plaintext of chunk `index` from its ciphertext (65,552 bytes, or fewer for the last).
    /// `Crypto` when it has the wrong length or doesn't decrypt: changed, moved to another
    /// position, or taken for the last chunk when it isn't.
    pub fn open_chunk(
        &self,
        header: &Header,
        index: u64,
        cipher: &[u8],
    ) -> Result<Vec<u8>, SyncError> {
        let n = chunk_count(header.plain_len);
        if index >= n {
            return Err(SyncError::new(
                SyncErrorKind::Crypto,
                "The object has no chunk at this position.",
            ));
        }
        if cipher.len() as u64 != chunk_plain_len(header.plain_len, index) + TAG {
            return Err(SyncError::new(
                SyncErrorKind::Crypto,
                "A chunk of the object has the wrong length.",
            ));
        }
        let mut buf = cipher.to_vec();
        aead(&self.dek)
            .decrypt_in_place(&self.nonce(index, index + 1 == n), b"", &mut buf)
            .map_err(|_| {
                SyncError::new(
                    SyncErrorKind::Crypto,
                    "A chunk of the object doesn't decrypt: it was changed, moved or cut short.",
                )
            })?;
        Ok(buf)
    }

    /// `prefix ‖ BE32(index) ‖ last`.
    fn nonce(&self, index: u64, last: bool) -> XNonce {
        let mut nonce = [0u8; 24];
        nonce[..19].copy_from_slice(&self.prefix);
        nonce[19..23].copy_from_slice(&(index as u32).to_be_bytes());
        nonce[23] = u8::from(last);
        XNonce::from(nonce)
    }
}

/// Decrypts a whole object named `object`: its header, every chunk, and its exact length.
pub fn open_object(key: &MasterKey, object: &str, bytes: &[u8]) -> Result<Vec<u8>, SyncError> {
    let header = Header::parse(bytes)?;
    let sealer = Sealer::open(key, object, &header)?;
    let total = cipher_len(header.plain_len);
    if bytes.len() as u64 != total {
        return Err(SyncError::new(
            SyncErrorKind::Crypto,
            "The object is cut short or has bytes after its end.",
        ));
    }
    let mut out = Vec::with_capacity(header.plain_len as usize);
    for index in 0..chunk_count(header.plain_len) {
        let from = HEADER_LEN + index * CIPHER_CHUNK;
        let to = (from + CIPHER_CHUNK).min(total);
        out.extend_from_slice(&sealer.open_chunk(
            &header,
            index,
            &bytes[from as usize..to as usize],
        )?);
    }
    Ok(out)
}

fn aead(key: &[u8; 32]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new_from_slice(key).expect("XChaCha20-Poly1305 takes a 32-byte key")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_follow_the_chunks() {
        assert_eq!(cipher_len(0), 115 + 16);
        assert_eq!(cipher_len(1), 115 + 1 + 16);
        assert_eq!(cipher_len(65_536), 115 + 65_536 + 16);
        assert_eq!(cipher_len(65_537), 115 + 65_537 + 32);
        assert_eq!(cipher_len(960_044), 960_044 + 355);
    }

    #[test]
    fn empty_ranges_are_empty() {
        assert_eq!(cipher_range(0, 0, 0), (115, 115));
        assert_eq!(cipher_range(10, 5, 5), (115, 115));
        let end = cipher_len(65_536);
        assert_eq!(cipher_range(65_536, 65_536, 65_536), (end, end));
        assert_eq!(cipher_range(65_536, 70_000, 80_000), (end, end));
    }
}
