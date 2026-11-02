//! Opaque object names in the bucket (spec 2.4). Keys here are without the user's `<prefix>`.

pub const ROOT: &str = "rkv1/";
pub const PROBE_PREFIX: &str = "rkv1/probe/";

/// `M`: `hex(HMAC(nameKey, "meeting\0" + meetingId))[0..32]`.
pub fn meeting_hash(name_key: &[u8; 32], meeting: &str) -> String {
    let _ = (name_key, meeting);
    todo!()
}

/// `rkv1/<kid>/m/<M>/o/<F>`, where `F` covers the meeting, the path and the plaintext's SHA-256.
pub fn file_object(
    kid: &str,
    mhash: &str,
    name_key: &[u8; 32],
    meeting: &str,
    path: &str,
    sha256_hex: &str,
) -> String {
    let _ = (kid, mhash, name_key, meeting, path, sha256_hex);
    todo!()
}

/// `rkv1/<kid>/m/<M>/manifest`.
pub fn manifest_object(kid: &str, mhash: &str) -> String {
    let _ = (kid, mhash);
    todo!()
}

/// `rkv1/<kid>/index/<W>`.
pub fn index_object(kid: &str, name_key: &[u8; 32], writer: &str) -> String {
    let _ = (kid, name_key, writer);
    todo!()
}

/// `rkv1/<kid>/index/`.
pub fn index_prefix(kid: &str) -> String {
    let _ = kid;
    todo!()
}
