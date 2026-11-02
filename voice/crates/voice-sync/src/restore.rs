//! Restore and fetching back (spec 2.11): `ensure_local`, `remote_meetings`, one meeting's restore
//! and the timeline of a meeting whose computer was lost mid-recording.
//!
//! Every path and meeting id that comes from a decrypted manifest or index is checked before
//! anything is written: AEAD stops the storage provider from changing a manifest, but any holder of
//! the key, such as a buggy older Voice on another computer, could otherwise write outside
//! `<meetings>/<id>/`.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, PoisonError};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use voice_meetings::MeetingFile;
use voice_protocol::MeetingId;
use voice_recorder::timeline::{self, samples_to_ms, Line};

use crate::format::{cipher_len, Header, Sealer, CHUNK, HEADER_LEN, TAG};
use crate::keys::MasterKey;
use crate::manifest::{
    is_meeting_path, is_segment_file, merge_indexes, Index, Manifest, ManifestFile,
};
use crate::names;
use crate::queue::{hex, Import, MEDIA_KINDS};
use crate::s3::Bucket;
use crate::sync::RemoteMeeting;
use crate::worker::{background_thread, local, panic_text, Binding, Remote, Shared};
use crate::{SyncError, SyncErrorKind};

/// What a refused manifest or index says (2.11).
pub const BAD_MANIFEST: &str = "The bucket holds a manifest Voice can't use.";
/// What a refused write says when `reserve` refuses it.
pub const NO_ROOM: &str = "Not enough free disk space.";
/// Fetches read this many encrypted chunks per request: 8 MiB of plaintext.
const CHUNKS_PER_GET: u64 = 128;
/// The prefix of a restore's temporary folder in `<meetings>`, skipped by the library.
pub const RESTORE_PREFIX: &str = ".restore-";
/// How long a restore waits for the worker to start the queue for the bucket it restores from.
const QUEUE_WAIT: Duration = Duration::from_secs(30);

/// A timeline in voice/RECORDING.md's format from the manifest's audio entries, sorted by `t`: a
/// `session` line at 0 with `wall` = `created_at`, a `segment` and `segment_end` per entry, and
/// `stop` with reason `interrupted` at the latest end.
pub fn synthesize_timeline(created_at: u64, files: &[ManifestFile]) -> String {
    let mut segments: Vec<(u64, String, u64, String, u64)> = files
        .iter()
        .filter(|f| f.kind == "audio" && is_meeting_path(&f.path))
        .filter_map(|f| {
            let track = f.track.clone().or_else(|| track_of(&f.path))?;
            let seq = f.seq.or_else(|| seq_of(&f.path))?;
            is_segment_file(&track, seq, &f.path).then_some(())?;
            Some((f.t?, track, seq, f.path.clone(), f.samples?))
        })
        .collect();
    segments.sort_by(|a, b| (a.0, &a.1, a.2).cmp(&(b.0, &b.1, b.2)));
    let mut lines = vec![Line::Session {
        t: 0,
        wall: created_at,
        session: 1,
        pid: 0,
        resumed: false,
        version: timeline::FORMAT_VERSION,
        recorder: "restored".to_owned(),
    }];
    let mut end = 0;
    for (t, track, seq, file, samples) in segments {
        let segment_end = t + samples_to_ms(samples);
        end = end.max(segment_end);
        lines.push(Line::Segment {
            t,
            track: track.clone(),
            seq,
            file,
        });
        lines.push(Line::SegmentEnd {
            t: segment_end,
            track,
            seq,
            samples,
        });
    }
    lines.push(Line::Stop {
        t: end,
        wall: created_at + end,
        reason: "interrupted".to_owned(),
    });
    let mut text = String::new();
    for line in &lines {
        if let Ok(json) = serde_json::to_string(line) {
            text.push_str(&json);
            text.push('\n');
        }
    }
    text
}

fn track_of(path: &str) -> Option<String> {
    let mut parts = path.split('/');
    (parts.next() == Some("audio"))
        .then(|| parts.next().map(str::to_owned))
        .flatten()
}

fn seq_of(path: &str) -> Option<u64> {
    path.rsplit('/').next()?.strip_suffix(".wav")?.parse().ok()
}

/// GETs a whole object and opens it.
pub(crate) fn open_object(
    bucket: &Bucket,
    key: &MasterKey,
    object: &str,
) -> Result<Vec<u8>, SyncError> {
    let bytes = bucket.get(object, None)?;
    decrypt(key, object, &bytes)
}

/// Opens a whole `RKV1` object.
pub(crate) fn decrypt(key: &MasterKey, object: &str, bytes: &[u8]) -> Result<Vec<u8>, SyncError> {
    let (header, sealer) = open_header(key, object, bytes)?;
    let total = cipher_len(header.plain_len());
    if bytes.len() as u64 != total {
        return Err(crypto("An object in the bucket has the wrong length."));
    }
    let mut out = Vec::with_capacity(usize::try_from(header.plain_len()).unwrap_or(0));
    for i in 0..chunk_count(header.plain_len()) {
        let (from, to) = chunk_span(total, i);
        out.extend(sealer.open_chunk(&header, i, &bytes[to_usize(from)..to_usize(to)])?);
    }
    Ok(out)
}

/// The header at the start of `bytes`, checked against this key, and the sealer that opens it.
fn open_header(key: &MasterKey, object: &str, bytes: &[u8]) -> Result<(Header, Sealer), SyncError> {
    if (bytes.len() as u64) < HEADER_LEN {
        return Err(crypto("An object in the bucket is too short."));
    }
    let header = Header::parse(&bytes[..to_usize(HEADER_LEN)])?;
    if header.kid_hex() != key.kid() {
        return Err(SyncError::new(
            SyncErrorKind::Key,
            "This file in the bucket was saved with another encryption key.",
        ));
    }
    let sealer = Sealer::open(key, object, &header)?;
    Ok((header, sealer))
}

/// `max(1, ceil(len / 64 KiB))`.
fn chunk_count(plain_len: u64) -> u64 {
    plain_len.div_ceil(CHUNK).max(1)
}

/// The ciphertext bytes `[from, to)` of chunk `i` in an object of `total` bytes.
fn chunk_span(total: u64, i: u64) -> (u64, u64) {
    let from = HEADER_LEN + i * (CHUNK + TAG);
    (from, (from + CHUNK + TAG).min(total))
}

/// Fetches an object in 8 MiB ranges, decrypts it chunk by chunk into `<dest>.restore`, checks its
/// size and SHA-256 and renames it into place.
#[allow(clippy::too_many_arguments)]
pub(crate) fn fetch_to_file(
    bucket: &Bucket,
    key: &MasterKey,
    object: &str,
    size: u64,
    sha256: &str,
    dest: &Path,
    cancel: &AtomicBool,
) -> Result<(), SyncError> {
    let total = cipher_len(size);
    let span = CHUNKS_PER_GET * (CHUNK + TAG);
    let first = bucket.get(object, Some((0, (HEADER_LEN + span).min(total) - 1)))?;
    let (header, sealer) = open_header(key, object, &first)?;
    if header.plain_len() != size {
        return Err(crypto(
            "A file in the bucket has another size than its manifest says.",
        ));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| local("Voice can't make a folder", &e))?;
    }
    let part = partial_path(dest);
    let result = (|| {
        let mut out =
            File::create(&part).map_err(|e| local("Voice can't write a fetched file", &e))?;
        let mut hasher = Sha256::new();
        let chunks = chunk_count(size);
        let mut buffer = first;
        let mut buffer_from = 0u64;
        for i in 0..chunks {
            if cancel.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            let (from, to) = chunk_span(total, i);
            if to > buffer_from + buffer.len() as u64 {
                let end = (from + span).min(total);
                buffer = bucket.get(object, Some((from, end - 1)))?;
                buffer_from = from;
                if (buffer.len() as u64) < to - from {
                    return Err(crypto(
                        "A file in the bucket is shorter than its header says.",
                    ));
                }
            }
            let at = to_usize(from - buffer_from);
            let plain = sealer.open_chunk(&header, i, &buffer[at..at + to_usize(to - from)])?;
            hasher.update(&plain);
            out.write_all(&plain)
                .map_err(|e| local("Voice can't write a fetched file", &e))?;
        }
        out.sync_all()
            .map_err(|e| local("Voice can't write a fetched file", &e))?;
        drop(out);
        if hex(&hasher.finalize()) != sha256 {
            return Err(crypto("A file from the bucket doesn't match its manifest."));
        }
        fs::rename(&part, dest).map_err(|e| local("Voice can't put a fetched file in place", &e))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result
}

fn partial_path(dest: &Path) -> PathBuf {
    let mut name = dest.as_os_str().to_owned();
    name.push(".restore");
    PathBuf::from(name)
}

/// `ensure_local` (2.11): each path that isn't on disk with its row's size comes back from the
/// bucket. A text file that is on disk stays as it is whatever its size: it may be newer than its
/// last upload, and `transcript.db` may be open in the pipeline.
pub(crate) fn ensure_local(
    shared: &Shared,
    meeting: &str,
    paths: &[String],
    cancel: &AtomicBool,
) -> Result<(), SyncError> {
    if MeetingId::parse(meeting).is_none() {
        return Err(SyncError::new(
            SyncErrorKind::NotInBucket,
            "That isn't a meeting id.",
        ));
    }
    let dir = shared.meeting_dir(meeting);
    let mut remote: Option<Remote> = None;
    for path in paths {
        if !is_meeting_path(path) {
            return Err(SyncError::new(
                SyncErrorKind::NotInBucket,
                "That isn't a file sync keeps.",
            ));
        }
        let dest = dir.join(path);
        // Another fetch of this file finishes first; then it is on disk and this one skips it.
        let _claim = Claim::take(shared, &dest, cancel)?;
        let now = shared.now();
        let row = shared.queue.in_bucket(meeting, path)?;
        if let Ok(meta) = fs::metadata(&dest) {
            let keep = !is_media_path(path) || row.as_ref().is_none_or(|r| r.size == meta.len());
            if meta.is_file() && keep {
                shared.queue.touch_restored(meeting, path, now)?;
                continue;
            }
        }
        if shared.cfg().is_none() {
            return Err(SyncError::new(SyncErrorKind::Off, "Bucket sync is off."));
        }
        let row = row.ok_or_else(|| {
            SyncError::new(SyncErrorKind::NotInBucket, "That file isn't in the bucket.")
        })?;
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        if !(shared.opts.reserve)(row.size) {
            return Err(SyncError::new(SyncErrorKind::Local, NO_ROOM));
        }
        if remote.is_none() {
            remote = Some(shared.remote()?.0);
        }
        let r = remote.as_ref().expect("just connected");
        // Held from retention while it comes back, not only once it is in place (2.10).
        shared.queue.restored(meeting, path, now)?;
        fetch_to_file(
            &r.bucket,
            &r.key,
            &row.object,
            row.size,
            &row.sha256,
            &dest,
            cancel,
        )?;
        shared.queue.restored(meeting, path, shared.now())?;
    }
    Ok(())
}

/// Audio, frames and video: files that never change once they went up, so one on disk with
/// another size than its row is damaged and comes back from the bucket.
fn is_media_path(path: &str) -> bool {
    ["audio/", "screen/frames/", "screen/video/"]
        .iter()
        .any(|dir| path.starts_with(dir))
}

fn cancelled() -> SyncError {
    SyncError::new(SyncErrorKind::Local, "Cancelled.")
}

/// One fetch of a file at a time: two fetches writing the same `<file>.restore` would interleave,
/// and each checks the hash of the bytes it wrote, not of the file on disk.
struct Claim<'a> {
    shared: &'a Shared,
    path: PathBuf,
}

impl<'a> Claim<'a> {
    fn take(shared: &'a Shared, path: &Path, cancel: &AtomicBool) -> Result<Claim<'a>, SyncError> {
        let mut fetching = shared
            .fetching
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        while fetching.contains(path) {
            if cancel.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            fetching = shared
                .fetched
                .wait_timeout(fetching, Duration::from_millis(200))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        fetching.insert(path.to_owned());
        Ok(Claim {
            shared,
            path: path.to_owned(),
        })
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        self.shared
            .fetching
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.path);
        self.shared.fetched.notify_all();
    }
}

/// Removes the `.restore-<id>` folders of restores that a hard kill cut off. `open` calls it before
/// the worker starts, when no restore runs.
pub(crate) fn clear_partial(meetings: &Path) {
    let Ok(entries) = fs::read_dir(meetings) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let partial = name
            .to_str()
            .and_then(|n| n.strip_prefix(RESTORE_PREFIX))
            .is_some_and(|id| MeetingId::parse(id).is_some());
        if partial && entry.path().is_dir() {
            if let Err(e) = fs::remove_dir_all(entry.path()) {
                log::warn!("sync: can't remove an unfinished restore: {e}");
            }
        }
    }
}

/// The bucket's meetings that aren't on this computer, newest first: every index under
/// `rkv1/<kid>/index/` merged, deleted ones and ids that don't parse left out.
pub(crate) fn list_remote(
    shared: &Shared,
    remote: &Remote,
) -> Result<Vec<RemoteMeeting>, SyncError> {
    let listing = remote
        .bucket
        .list(&names::index_prefix(&remote.kid), None)?;
    let mut indexes = Vec::new();
    for (object, _) in &listing.keys {
        let bytes = match open_object(&remote.bucket, &remote.key, object) {
            Ok(bytes) => bytes,
            Err(e) if e.kind == SyncErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        match serde_json::from_slice::<Index>(&bytes) {
            Ok(index) => indexes.push(index),
            Err(_) => log::warn!("sync: an index in the bucket is unreadable"),
        }
    }
    let local: HashSet<String> = crate::worker::meeting_dirs(&shared.opts.meetings_dir)
        .into_iter()
        .map(|d| d.id().as_str().to_owned())
        .collect();
    Ok(merge_indexes(indexes)
        .into_iter()
        .filter(|e| !e.deleted && MeetingId::parse(&e.id).is_some() && !local.contains(&e.id))
        .map(|e| RemoteMeeting {
            id: e.id,
            title: e.title,
            started_at: e.created_at,
            duration_ms: e.duration_ms,
        })
        .collect())
}

/// Restores `ids` one at a time on the `sync-restore` thread; empty means every meeting the bucket
/// has that this computer doesn't.
pub(crate) fn spawn_restore(
    shared: Arc<Shared>,
    ids: Vec<String>,
    on_restored: Box<dyn Fn(&str) + Send>,
) -> Result<(), SyncError> {
    if shared.cfg().is_none() {
        return Err(SyncError::new(SyncErrorKind::Off, "Bucket sync is off."));
    }
    {
        let mut st = shared.lock();
        if st.restoring {
            return Err(SyncError::new(
                SyncErrorKind::Local,
                "A restore is running already.",
            ));
        }
        st.restoring = true;
        st.restore.state = "restoring";
        st.restore.done = 0;
        st.restore.total = u32::try_from(ids.len()).unwrap_or(u32::MAX);
        st.restore.error = None;
    }
    shared.changed();
    let thread_shared = shared.clone();
    let spawned = std::thread::Builder::new()
        .name("sync-restore".into())
        .spawn(move || {
            background_thread();
            let shared = thread_shared;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                restore_all(&shared, ids, on_restored.as_ref())
            }))
            .unwrap_or_else(|panic| {
                log::error!("sync restore panicked: {}", panic_text(&panic));
                Err(SyncError::new(
                    SyncErrorKind::Local,
                    "Restoring stopped unexpectedly.",
                ))
            });
            {
                let mut st = shared.lock();
                st.restoring = false;
                match result {
                    Ok(()) => {
                        st.restore.state = "done";
                        st.restore.available = st.restore.available.saturating_sub(st.restore.done);
                    }
                    Err(e) => {
                        log::warn!("sync: restore stopped: {e}");
                        st.restore.state = "failed";
                        st.restore.error = Some(e.message);
                    }
                }
            }
            shared.changed();
            shared.poke();
        });
    if let Err(e) = spawned {
        let mut st = shared.lock();
        st.restoring = false;
        st.restore.state = "failed";
        st.restore.error = Some("Voice can't start restoring.".into());
        drop(st);
        shared.changed();
        return Err(local("Voice can't start restoring", &e));
    }
    Ok(())
}

fn restore_all(
    shared: &Shared,
    ids: Vec<String>,
    on_restored: &(dyn Fn(&str) + Send),
) -> Result<(), SyncError> {
    let (remote, binding) = shared.remote()?;
    let ids = if ids.is_empty() {
        let ids: Vec<String> = list_remote(shared, &remote)?
            .into_iter()
            .map(|m| m.id)
            .collect();
        shared.lock().restore.total = u32::try_from(ids.len()).unwrap_or(u32::MAX);
        shared.changed();
        ids
    } else {
        ids
    };
    for id in ids {
        shared.still(&binding)?;
        if restore_one(shared, &remote, &binding, &id)? {
            on_restored(&id);
        }
        shared.lock().restore.done += 1;
        shared.changed();
    }
    Ok(())
}

/// One meeting (2.11 steps 1 to 5), read with `binding`. False when it is on this computer already.
pub(crate) fn restore_one(
    shared: &Shared,
    remote: &Remote,
    binding: &Binding,
    id: &str,
) -> Result<bool, SyncError> {
    if MeetingId::parse(id).is_none() {
        return Err(crypto(BAD_MANIFEST));
    }
    let meetings = &shared.opts.meetings_dir;
    let target = meetings.join(id);
    if target.join(voice_meetings::MEETING_FILE).is_file() {
        return Ok(false);
    }
    let mhash = names::meeting_hash(&remote.name_key, id);
    let object = names::manifest_object(&remote.kid, &mhash);
    let bytes = match open_object(&remote.bucket, &remote.key, &object) {
        Ok(bytes) => bytes,
        Err(e) if e.kind == SyncErrorKind::NotFound => {
            return Err(SyncError::new(
                SyncErrorKind::NotInBucket,
                "That meeting isn't in the bucket.",
            ))
        }
        Err(e) => return Err(e),
    };
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| crypto(BAD_MANIFEST))?;
    check_manifest(&manifest, id, &remote.kid, &mhash)?;

    let tmp = meetings.join(format!("{RESTORE_PREFIX}{id}"));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| local("Voice can't make a folder to restore into", &e))?;
    let result = restore_into(
        shared, remote, binding, &manifest, id, &mhash, &tmp, &target,
    );
    if result.is_err() {
        let _ = fs::remove_dir_all(&tmp);
    }
    result.map(|()| true)
}

/// Refuses a manifest with another meeting's id, a path outside the meeting folder's files, a
/// file twice, or an object outside this meeting's folder in the bucket.
fn check_manifest(manifest: &Manifest, id: &str, kid: &str, mhash: &str) -> Result<(), SyncError> {
    if manifest.meeting != id || MeetingId::parse(&manifest.meeting).is_none() {
        return Err(crypto(BAD_MANIFEST));
    }
    let objects = format!("rkv1/{kid}/m/{mhash}/o/");
    let mut paths = HashSet::new();
    for file in &manifest.files {
        let name_ok = file
            .object
            .strip_prefix(&objects)
            .is_some_and(|f| f.len() == 32 && f.bytes().all(|b| b.is_ascii_hexdigit()));
        if !is_meeting_path(&file.path) || !name_ok || !paths.insert(file.path.as_str()) {
            return Err(crypto(BAD_MANIFEST));
        }
    }
    if !paths.contains(voice_meetings::MEETING_FILE) {
        return Err(crypto(BAD_MANIFEST));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn restore_into(
    shared: &Shared,
    remote: &Remote,
    binding: &Binding,
    manifest: &Manifest,
    id: &str,
    mhash: &str,
    tmp: &Path,
    target: &Path,
) -> Result<(), SyncError> {
    let never = AtomicBool::new(false);
    let fetch = |file: &ManifestFile| -> Result<(), SyncError> {
        shared.still(binding)?;
        if !(shared.opts.reserve)(file.size) {
            return Err(SyncError::new(SyncErrorKind::Local, NO_ROOM));
        }
        fetch_to_file(
            &remote.bucket,
            &remote.key,
            &file.object,
            file.size,
            &file.sha256,
            &tmp.join(&file.path),
            &never,
        )
    };
    // Text first: what Voice shows and sends to Rukoo. RUK-108's journal holds the frame text.
    let text = [
        "meeting.json",
        "timeline.jsonl",
        "transcript.db",
        "screen/journal.jsonl",
    ];
    for file in manifest
        .files
        .iter()
        .filter(|f| text.contains(&f.path.as_str()))
    {
        fetch(file)?;
    }
    let meeting_file: MeetingFile = fs::read(tmp.join(voice_meetings::MEETING_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| crypto(BAD_MANIFEST))?;
    if meeting_file.id.as_str() != id {
        return Err(crypto(BAD_MANIFEST));
    }
    let has_timeline = manifest.files.iter().any(|f| f.path == timeline::FILE_NAME);
    if has_timeline {
        // The timeline comes back byte for byte, and its segment lines name the files that media
        // links and transcription read: each must be the segment's own file in this folder.
        let lines = timeline::read(&tmp.join(timeline::FILE_NAME))
            .map_err(|e| local("Voice can't read a restored timeline", &e))?;
        let foreign = lines.iter().any(|line| match line {
            Line::Segment {
                track, seq, file, ..
            } => !is_segment_file(track, *seq, file),
            _ => false,
        });
        if foreign {
            return Err(crypto(BAD_MANIFEST));
        }
    } else {
        let text = synthesize_timeline(meeting_file.created_at, &manifest.files);
        fs::write(tmp.join(timeline::FILE_NAME), text)
            .map_err(|e| local("Voice can't write a timeline", &e))?;
    }
    let audio: Vec<&ManifestFile> = if manifest.state == "done" {
        Vec::new()
    } else {
        // Transcription has to finish on this computer.
        manifest
            .files
            .iter()
            .filter(|f| f.kind == "audio")
            .collect()
    };
    for file in &audio {
        fetch(file)?;
    }
    let duration_ms = manifest
        .files
        .iter()
        .filter_map(|f| Some(f.t? + samples_to_ms(f.samples?)))
        .max();
    let import = Import {
        meeting: id,
        mhash,
        title: &meeting_file.title,
        created_at: meeting_file.created_at,
        duration_ms,
        state: &manifest.state,
        gen: manifest.gen,
        media_removed_at: manifest.media_removed_at,
        files: &manifest.files,
        now: shared.now(),
        target: &binding.target,
        kid: &binding.kid,
    };
    let media: Vec<&str> = audio
        .iter()
        .filter(|f| MEDIA_KINDS.contains(&f.kind.as_str()))
        .map(|f| f.path.as_str())
        .collect();
    put_in_place(shared, binding, &import, tmp, target, &media)
}

/// Imports the meeting's rows and renames its folder into place, under the worker's lock and only
/// while the restore's binding holds and the queue describes the bucket and key it read from. Rows
/// imported for another bucket would say that bucket has files it never got; rows imported before
/// the worker started the queue for this bucket would be dropped when it does.
fn put_in_place(
    shared: &Shared,
    binding: &Binding,
    import: &Import<'_>,
    tmp: &Path,
    target: &Path,
    media: &[&str],
) -> Result<(), SyncError> {
    let deadline = Instant::now() + QUEUE_WAIT;
    for attempt in 0.. {
        {
            let _busy = shared.busy();
            shared.still(binding)?;
            if shared.queue.import(import)? {
                fs::rename(tmp, target)
                    .map_err(|e| local("Voice can't put a restored meeting in place", &e))?;
                for path in media {
                    shared.queue.restored(import.meeting, path, import.now)?;
                }
                return Ok(());
            }
        }
        // The worker hasn't started the queue for this bucket yet.
        if Instant::now() >= deadline {
            break;
        }
        if attempt == 0 {
            shared.poke();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err(SyncError::new(
        SyncErrorKind::Local,
        "Sync hasn't started with this bucket yet.",
    ))
}

fn crypto(message: &str) -> SyncError {
    SyncError::new(SyncErrorKind::Crypto, message)
}

fn to_usize(n: u64) -> usize {
    usize::try_from(n).unwrap_or(usize::MAX)
}
