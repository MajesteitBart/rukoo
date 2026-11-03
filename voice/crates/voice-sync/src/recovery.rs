//! The recovery code `RKV1-…`: the master key in Crockford base32 with a checksum (spec 2.5).
//!
//! The 34 bytes `MK ‖ SHA-256(MK)[0..2]` make 272 bits, so 55 symbols whose last one carries
//! three zero bits of padding, written as 11 groups of 5 after `RKV1`.

use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::keys::MasterKey;
use crate::{SyncError, SyncErrorKind};

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIX: &str = "RKV1";
const BYTES: usize = 34;
const SYMBOLS: usize = 55;
const GROUP: usize = 5;

/// `RKV1-` and the Crockford base32 of `MK ‖ SHA-256(MK)[0..2]` in 11 groups of 5.
pub fn encode(key: &MasterKey) -> String {
    let mut data = Zeroizing::new([0u8; BYTES]);
    data[..32].copy_from_slice(key.bytes());
    data[32..].copy_from_slice(&Sha256::digest(key.bytes())[..2]);

    let mut out = String::with_capacity(PREFIX.len() + SYMBOLS + SYMBOLS / GROUP);
    out.push_str(PREFIX);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    let mut written = 0usize;
    let mut push = |value: u32, out: &mut String| {
        if written % GROUP == 0 {
            out.push('-');
        }
        out.push(ALPHABET[value as usize & 31] as char);
        written += 1;
    };
    for &byte in data.iter() {
        acc = (acc << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            push(acc >> bits, &mut out);
        }
        acc &= (1 << bits) - 1;
    }
    if bits > 0 {
        push(acc << (5 - bits), &mut out);
    }
    acc.zeroize();
    out
}

/// Ignores case, spaces and hyphens, reads `I` and `L` as `1` and `O` as `0`, and refuses a wrong
/// checksum. `RKV1` in front may be left out. Anything that isn't a key is `Key`.
pub fn decode(code: &str) -> Result<MasterKey, SyncError> {
    let refuse = |message: &str| SyncError::new(SyncErrorKind::Key, message);
    let mut symbols: Zeroizing<Vec<u8>> = Zeroizing::new(Vec::with_capacity(64));
    for c in code.chars() {
        if c == '-' || c.is_whitespace() {
            continue;
        }
        let c = match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        };
        if !c.is_ascii() || symbols.len() > PREFIX.len() + SYMBOLS {
            return Err(refuse("This isn't a recovery code."));
        }
        symbols.push(c as u8);
    }
    let body: &[u8] =
        if symbols.len() == PREFIX.len() + SYMBOLS && symbols.starts_with(PREFIX.as_bytes()) {
            &symbols[PREFIX.len()..]
        } else if symbols.len() == SYMBOLS {
            &symbols
        } else {
            return Err(refuse(
                "A recovery code has 55 letters and digits after RKV1.",
            ));
        };

    let mut data = Zeroizing::new([0u8; BYTES]);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    let mut filled = 0usize;
    for &symbol in body {
        let Some(value) = ALPHABET.iter().position(|&a| a == symbol) else {
            return Err(refuse("This isn't a recovery code."));
        };
        acc = (acc << 5) | value as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            if filled < BYTES {
                data[filled] = (acc >> bits) as u8;
                filled += 1;
            }
        }
        acc &= (1 << bits) - 1;
    }
    acc.zeroize();
    let sum = Sha256::digest(&data[..32]);
    if data[32..] != sum[..2] {
        return Err(refuse(
            "This recovery code has a typo: its check digits don't match.",
        ));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&data[..32]);
    let master = MasterKey::from_bytes(key);
    key.zeroize();
    Ok(master)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_code_has_eleven_groups_of_five() {
        let code = encode(&MasterKey::from_bytes([0xa5; 32]));
        assert!(code.starts_with("RKV1-"));
        let groups: Vec<&str> = code.split('-').collect();
        assert_eq!(groups.len(), 12);
        assert!(groups[1..].iter().all(|g| g.len() == 5));
        assert_eq!(code.len(), 4 + 11 * 6);
        assert_eq!(
            decode(&code).unwrap().kid(),
            MasterKey::from_bytes([0xa5; 32]).kid()
        );
    }

    #[test]
    fn all_zero_and_all_one_keys_round_trip() {
        for byte in [0u8, 0xff] {
            let key = MasterKey::from_bytes([byte; 32]);
            assert_eq!(decode(&encode(&key)).unwrap().kid(), key.kid());
        }
    }
}
