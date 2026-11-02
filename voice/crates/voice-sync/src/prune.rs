//! Bucket retention and `forget_meeting` (spec 2.10): media objects of meetings done longer ago
//! than `storage.sync.retention` go, text stays.

use std::collections::HashSet;

use crate::names;
use crate::worker::{Remote, Shared};
use crate::{BucketRetention, SyncError};

const DAY_MS: u64 = 86_400_000;

/// Removes the media objects (`audio`, `frame`, `video`) of meetings done longer ago than
/// `retention`, with DeleteObjects in batches of 1,000. Their rows become `removed`, rows that
/// never went up too, and each meeting gets `mediaRemovedAt` and a new manifest without them; the
/// index follows the manifests. Returns how many meetings lost their media.
pub(crate) fn bucket_retention(
    shared: &Shared,
    remote: &Remote,
    retention: BucketRetention,
    now: u64,
) -> Result<u32, SyncError> {
    let days = match retention {
        BucketRetention::Keep => return Ok(0),
        BucketRetention::Days365 => 365,
        BucketRetention::Days90 => 90,
    };
    let cutoff = now.saturating_sub(days * DAY_MS);
    let mut pruned = 0;
    for (meeting, rows) in shared.queue.expired_media(cutoff)? {
        if shared.stopping() {
            break;
        }
        let in_bucket: Vec<String> = rows
            .iter()
            .filter(|r| r.state == crate::queue::RowState::Done)
            .map(|r| r.object.clone())
            .collect();
        let failed: HashSet<String> = if in_bucket.is_empty() {
            HashSet::new()
        } else {
            remote.bucket.delete_many(&in_bucket)?.into_iter().collect()
        };
        let removed: Vec<i64> = rows
            .iter()
            .filter(|r| !failed.contains(&r.object))
            .map(|r| r.id)
            .collect();
        // The manifest is due before the rows change, so something is pending throughout.
        if failed.is_empty() {
            shared.queue.set_media_removed(&meeting, now)?;
            pruned += 1;
        } else {
            shared.queue.set_manifest_dirty(&meeting)?;
        }
        shared.queue.mark_removed(&removed)?;
    }
    Ok(pruned)
}

/// `forget_meeting` (2.10). With `delete_objects`, deletes every object of the meeting and its
/// manifest, aborts its open multipart uploads, drops its rows and keeps it as `forgotten`, so the
/// next index marks it deleted. Without, only drops its rows.
pub(crate) fn forget(
    shared: &Shared,
    meeting: &str,
    delete_objects: bool,
) -> Result<(), SyncError> {
    if !delete_objects {
        shared.queue.drop_meeting(meeting, false)?;
        shared.changed();
        return Ok(());
    }
    let (remote, _) = shared.remote()?;
    let rows = shared.queue.rows_of(meeting)?;
    let mhash = match shared.queue.meeting(meeting)? {
        Some(m) => m.mhash,
        None => names::meeting_hash(&remote.name_key, meeting),
    };
    for row in &rows {
        if let Some(upload_id) = &row.upload_id {
            match remote.bucket.abort_multipart(&row.object, upload_id) {
                Ok(()) => {}
                Err(e)
                    if matches!(
                        e.kind,
                        crate::SyncErrorKind::NoSuchUpload | crate::SyncErrorKind::NotFound
                    ) => {}
                Err(e) => return Err(e),
            }
        }
    }
    // Everything under the meeting's folder in the bucket, whoever wrote it, and what the rows
    // name, in case a listing is behind.
    let folder = format!("rkv1/{}/m/{mhash}/", remote.kid);
    let mut keys: Vec<String> = remote
        .bucket
        .list(&folder, None)?
        .keys
        .into_iter()
        .map(|(key, _)| key)
        .collect();
    keys.extend(
        rows.iter()
            .filter(|r| r.object.starts_with(&folder))
            .map(|r| r.object.clone()),
    );
    keys.push(names::manifest_object(&remote.kid, &mhash));
    keys.sort();
    keys.dedup();
    let failed = remote.bucket.delete_many(&keys)?;
    if !failed.is_empty() {
        return Err(SyncError::new(
            crate::SyncErrorKind::Server,
            format!("The bucket kept {} of the meeting's files.", failed.len()),
        ));
    }
    shared.queue.drop_meeting(meeting, true)?;
    let now = shared.now();
    shared.queue.set_meta("index_due", Some(&now.to_string()))?;
    shared.changed();
    shared.poke();
    Ok(())
}
