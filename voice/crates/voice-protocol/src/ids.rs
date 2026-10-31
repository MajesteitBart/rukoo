use std::fmt;
use std::io;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::Invalid;

/// A meeting id: `m-`, the start time in UTC as `YYYYMMDD-HHMMSS`, a dash and four lowercase
/// hex digits, such as `m-20261030-171203-4f2a`.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct MeetingId(String);

impl MeetingId {
    /// A new id for a meeting that starts at `now`, with a random suffix.
    ///
    /// Two meetings started in the same second get the same suffix once in 65,536 times, so the
    /// caller still checks that the meeting folder doesn't exist yet.
    pub fn new(now: SystemTime) -> MeetingId {
        let since_epoch = now.duration_since(UNIX_EPOCH).unwrap_or_default();
        let mut suffix = [0u8; 2];
        if getrandom::fill(&mut suffix).is_err() {
            // The suffix only separates meetings started in the same second; it guards no secret.
            suffix = (since_epoch.subsec_nanos() as u16).to_le_bytes();
        }
        let millis = u64::try_from(since_epoch.as_millis()).unwrap_or(u64::MAX);
        MeetingId::with_suffix(millis, u16::from_le_bytes(suffix))
    }

    /// The id for a meeting that started `started_at` ms after the Unix epoch, with a chosen
    /// suffix.
    pub fn with_suffix(started_at: u64, suffix: u16) -> MeetingId {
        let secs = started_at / 1000;
        let (year, month, day) = civil_from_days(secs / 86_400);
        let of_day = secs % 86_400;
        MeetingId(format!(
            "m-{year:04}{month:02}{day:02}-{:02}{:02}{:02}-{suffix:04x}",
            of_day / 3600,
            of_day % 3600 / 60,
            of_day % 60,
        ))
    }

    /// Reads an id, or `None` when it doesn't have the shape of one.
    pub fn parse(id: &str) -> Option<MeetingId> {
        is_meeting_id(id).then(|| MeetingId(id.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl fmt::Debug for MeetingId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

impl fmt::Display for MeetingId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for MeetingId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl FromStr for MeetingId {
    type Err = Invalid;

    fn from_str(id: &str) -> Result<MeetingId, Invalid> {
        MeetingId::parse(id).ok_or_else(|| Invalid::new("meeting"))
    }
}

impl TryFrom<String> for MeetingId {
    type Error = Invalid;

    fn try_from(id: String) -> Result<MeetingId, Invalid> {
        if is_meeting_id(&id) {
            Ok(MeetingId(id))
        } else {
            Err(Invalid::new("meeting"))
        }
    }
}

impl From<MeetingId> for String {
    fn from(id: MeetingId) -> String {
        id.0
    }
}

impl PartialEq<str> for MeetingId {
    fn eq(&self, other: &str) -> bool {
        self.0 == other
    }
}

impl PartialEq<&str> for MeetingId {
    fn eq(&self, other: &&str) -> bool {
        self.0 == *other
    }
}

impl Serialize for MeetingId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for MeetingId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<MeetingId, D::Error> {
        let id = String::deserialize(deserializer)?;
        MeetingId::try_from(id).map_err(|_| serde::de::Error::custom("not a meeting id"))
    }
}

/// True when `id` matches `^m-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$`.
pub fn is_meeting_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 22
        && b.starts_with(b"m-")
        && b[2..10].iter().all(u8::is_ascii_digit)
        && b[10] == b'-'
        && b[11..17].iter().all(u8::is_ascii_digit)
        && b[17] == b'-'
        && b[18..]
            .iter()
            .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// True when `token` matches `^[A-Za-z0-9_-]{43}$`: 32 bytes in base64url without padding.
pub fn is_token(token: &str) -> bool {
    token.len() == 43 && is_base64url(token)
}

/// True when `instance` matches `^[A-Za-z0-9_-]{22}$`: 16 bytes in base64url without padding.
pub fn is_instance(instance: &str) -> bool {
    instance.len() == 22 && is_base64url(instance)
}

fn is_base64url(text: &str) -> bool {
    text.bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// A fresh bridge token: 32 random bytes from the operating system, in base64url.
pub fn new_token() -> io::Result<String> {
    random_base64url::<32>()
}

/// A fresh instance id: 16 random bytes from the operating system, in base64url.
pub fn new_instance() -> io::Result<String> {
    random_base64url::<16>()
}

fn random_base64url<const N: usize>() -> io::Result<String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(format!("no random bytes: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// The id of a passage: the track, a dash and its start in ms as nine digits, such as
/// `call-000065320`. Starts of 10^9 ms (11 days) and more get more digits.
pub fn passage_id(track: impl AsRef<str>, start: u64) -> String {
    format!("{}-{start:09}", track.as_ref())
}

/// Converts days since 1970-01-01 to a proleptic Gregorian (year, month, day).
///
/// Howard Hinnant's `civil_from_days`, limited to dates after the epoch.
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn meeting_id_uses_the_utc_start_time() {
        // 2026-10-30T17:12:03.456Z
        let id = MeetingId::with_suffix(1_793_380_323_456, 0x4f2a);
        assert_eq!(id.as_str(), "m-20261030-171203-4f2a");
        assert_eq!(
            MeetingId::with_suffix(0, 0).as_str(),
            "m-19700101-000000-0000"
        );
        // 2028-02-29T23:59:59Z, a leap day.
        assert_eq!(
            MeetingId::with_suffix(1_835_481_599_000, 0xffff).as_str(),
            "m-20280229-235959-ffff"
        );
    }

    #[test]
    fn new_meeting_ids_have_the_protocol_shape() {
        let now = UNIX_EPOCH + Duration::from_millis(1_793_380_323_456);
        let id = MeetingId::new(now);
        assert!(is_meeting_id(id.as_str()), "{id}");
        assert!(id.as_str().starts_with("m-20261030-171203-"));
    }

    #[test]
    fn meeting_id_shape() {
        assert!(is_meeting_id("m-20261030-171203-4f2a"));
        for bad in [
            "",
            "meeting-1",
            "m-20261030-171203-4F2A",
            "m-20261030-171203-4f2",
            "m-20261030-171203-4f2ab",
            "m-2026103a-171203-4f2a",
            "x-20261030-171203-4f2a",
            "m-20261030_171203-4f2a",
        ] {
            assert!(!is_meeting_id(bad), "{bad}");
            assert!(MeetingId::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn meeting_ids_deserialize_only_in_shape() {
        let id: MeetingId = serde_json::from_str("\"m-20261030-171203-4f2a\"").unwrap();
        assert_eq!(id, "m-20261030-171203-4f2a");
        assert!(serde_json::from_str::<MeetingId>("\"meeting-1\"").is_err());
    }

    #[test]
    fn tokens_and_instances_are_base64url() {
        let token = new_token().unwrap();
        let instance = new_instance().unwrap();
        assert!(is_token(&token), "{token}");
        assert!(is_instance(&instance), "{instance}");
        assert_ne!(new_token().unwrap(), token);
        assert!(!is_token("q7hR0lJ3x2b8Yc5vN1mK4sT9wE6uA0dF3gH2jL5pZ8+"));
        assert!(!is_token("q7hR0lJ3x2b8Yc5vN1mK4sT9wE6uA0dF3gH2jL5pZ8o="));
        assert!(!is_instance("Vb3kQ9m2X7pL1sR4tY8wZQx"));
    }

    #[test]
    fn passage_ids_pad_the_start_to_nine_digits() {
        assert_eq!(passage_id("call", 65_320), "call-000065320");
        assert_eq!(passage_id(crate::Track::Mic, 0), "mic-000000000");
        assert_eq!(passage_id("mic", 1_234_567_890), "mic-1234567890");
    }
}
