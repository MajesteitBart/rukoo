//! Restore and fetching back (spec 2.11): `ensure_local`, `remote_meetings`, one meeting's restore
//! and the timeline of a meeting whose computer was lost mid-recording.

use crate::manifest::ManifestFile;

/// A timeline in voice/RECORDING.md's format from the manifest's audio entries, sorted by `t`: a
/// `session` line at 0 with `wall` = `created_at`, a `segment` and `segment_end` per entry, and
/// `stop` with reason `interrupted` at the latest end.
pub fn synthesize_timeline(created_at: u64, files: &[ManifestFile]) -> String {
    let _ = (created_at, files);
    todo!()
}
