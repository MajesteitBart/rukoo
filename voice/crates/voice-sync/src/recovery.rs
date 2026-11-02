//! The recovery code `RKV1-…`: the master key in Crockford base32 with a checksum (spec 2.5).

use crate::keys::MasterKey;
use crate::SyncError;

/// `RKV1-` and the Crockford base32 of `MK ‖ SHA-256(MK)[0..2]` in 11 groups of 5.
pub fn encode(key: &MasterKey) -> String {
    let _ = key;
    todo!()
}

/// Ignores case, spaces and hyphens, reads `I` and `L` as `1` and `O` as `0`, and refuses a wrong
/// checksum.
pub fn decode(code: &str) -> Result<MasterKey, SyncError> {
    let _ = code;
    todo!()
}
