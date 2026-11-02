//! Opaque object names in the bucket (spec 2.4). Keys here are without the user's `<prefix>`.
//!
//! Every derivation is a plain `HMAC-SHA256` of a UTF-8 label, with `\0` as one zero byte, not
//! HKDF; `voice/fixtures/sync-vectors.json` pins them.

use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

pub const ROOT: &str = "rkv1/";
pub const PROBE_PREFIX: &str = "rkv1/probe/";

/// `M`: `hex(HMAC(nameKey, "meeting\0" + meetingId))[0..32]`.
pub fn meeting_hash(name_key: &[u8; 32], meeting: &str) -> String {
    let mac = hmac_sha256(name_key, &[b"meeting\0", meeting.as_bytes()]);
    hex(&mac[..16])
}

/// `rkv1/<kid>/m/<M>/o/<F>`, where `F` covers the meeting, the path and the plaintext's SHA-256:
/// `hex(HMAC(nameKey, "file\0" + meetingId + "\0" + path + "\0" + sha256hex))[0..32]`.
pub fn file_object(
    kid: &str,
    mhash: &str,
    name_key: &[u8; 32],
    meeting: &str,
    path: &str,
    sha256_hex: &str,
) -> String {
    let mac = hmac_sha256(
        name_key,
        &[
            b"file\0",
            meeting.as_bytes(),
            b"\0",
            path.as_bytes(),
            b"\0",
            sha256_hex.as_bytes(),
        ],
    );
    format!("{ROOT}{kid}/m/{mhash}/o/{}", hex(&mac[..16]))
}

/// `rkv1/<kid>/m/<M>/manifest`.
pub fn manifest_object(kid: &str, mhash: &str) -> String {
    format!("{ROOT}{kid}/m/{mhash}/manifest")
}

/// `rkv1/<kid>/index/<W>`, with `W = hex(HMAC(nameKey, "writer\0" + writerId))[0..32]`.
pub fn index_object(kid: &str, name_key: &[u8; 32], writer: &str) -> String {
    let mac = hmac_sha256(name_key, &[b"writer\0", writer.as_bytes()]);
    format!("{}{}", index_prefix(kid), hex(&mac[..16]))
}

/// `rkv1/<kid>/index/`.
pub fn index_prefix(kid: &str) -> String {
    format!("{ROOT}{kid}/index/")
}

/// Lowercase hex.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 15)] as char);
    }
    out
}

/// Lowercase hex of the SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// `HMAC-SHA256(key, parts concatenated)`.
pub(crate) fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes a key of any length");
    for part in parts {
        mac.update(part);
    }
    mac.finalize().into_bytes().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_is_lowercase_and_padded() {
        assert_eq!(hex(&[0x00, 0x0f, 0xa0, 0xff]), "000fa0ff");
        assert_eq!(hex(&[]), "");
    }

    #[test]
    fn hmac_matches_rfc_4231_case_2() {
        let mac = hmac_sha256(b"Jefe", &[b"what do ya want ", b"for nothing?"]);
        assert_eq!(
            hex(&mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn names_have_the_documented_shape() {
        let key = [7u8; 32];
        let m = meeting_hash(&key, "m-20261030-171203-4f2a");
        assert_eq!(m.len(), 32);
        let f = file_object(
            "0f1e2d3c4b5a6978",
            &m,
            &key,
            "m-20261030-171203-4f2a",
            "meeting.json",
            &sha256_hex(b"{}"),
        );
        assert!(f.starts_with(&format!("rkv1/0f1e2d3c4b5a6978/m/{m}/o/")));
        assert_eq!(f.len(), "rkv1/0f1e2d3c4b5a6978/m/".len() + 32 + 3 + 32);
        assert_eq!(
            manifest_object("0f1e2d3c4b5a6978", &m),
            format!("rkv1/0f1e2d3c4b5a6978/m/{m}/manifest")
        );
        let w = index_object("0f1e2d3c4b5a6978", &key, "ab");
        assert!(w.starts_with("rkv1/0f1e2d3c4b5a6978/index/"));
        assert_eq!(w.len(), "rkv1/0f1e2d3c4b5a6978/index/".len() + 32);
    }
}
