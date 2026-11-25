//! Meetings from the user's other computers (voice/README.md, Storage). Every few minutes, and
//! when the engine asks, the `sync-pull` thread reads the bucket's indexes:
//!
//! - a finished meeting this computer doesn't have comes in as text, the way a restore brings it,
//!   and its media stays in the bucket until something asks for it (`ensure_local`);
//! - newer text of a meeting this computer has, such as a microphone split another computer made,
//!   replaces the old text once the transcript says something else;
//! - a meeting another computer deleted is deleted here too.
//!
//! The engine does the parts that touch its pipelines and event log through [`PullHooks`].
//!
//! A meeting that came in or changed this way gets a [`PULLED`] file in its folder, in the same
//! step that puts it in place. The engine follows such a meeting until its event log has all of
//! it and then removes the file, so a Voice that quits in between still tells Rukoo at its next
//! start.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use voice_meetings::MeetingFile;
use voice_protocol::MeetingId;
use voice_recorder::timeline::{self, samples_to_ms};

use crate::manifest::{merge_indexes, IndexEntry, Manifest};
use crate::names;
use crate::queue::Import;
use crate::restore::{
    check_manifest, check_meeting_file, check_timeline, fetch_to_file, open_object, read_indexes,
    restore_one, BAD_MANIFEST, NO_ROOM,
};
use crate::worker::{background_thread, local, panic_text, sha256_hex, Binding, Remote, Shared};
use crate::{SyncError, SyncErrorKind};

/// The prefix of the folder in `<meetings>` that newer text waits in before it replaces the old.
/// The library and the worker skip it; `open` finishes or removes one Voice left.
pub const UPDATE_PREFIX: &str = ".update-";

/// In a meeting folder: the meeting came from the bucket or changed from there, and Rukoo may not
/// have heard all of it yet.
pub const PULLED: &str = ".pulled";

/// In an update folder: the files listed here replace the meeting's, and the replacement must go
/// on to the end even after a crash (`finish_install`).
const INSTALL: &str = "install.json";

/// The files a pull keeps up to date: what Voice shows and sends to Rukoo. Media stays where it is.
const TEXT: [&str; 4] = [
    voice_meetings::MEETING_FILE,
    timeline::FILE_NAME,
    voice_meetings::transcript::FILE_NAME,
    "screen/journal.jsonl",
];

/// How long the thread sleeps at most between two looks at whether a pull is due.
const TICK: Duration = Duration::from_secs(1);

/// What the engine does with what a pull brings.
pub trait PullHooks: Send + Sync {
    /// A finished meeting from another computer is in place.
    fn restored(&self, meeting: &str);

    /// Newer text of a meeting this computer has waits. The engine stops whatever reads or writes
    /// the meeting's transcript, runs `swap`, which puts the new files in place, and then sends
    /// Rukoo what changed. An error from `swap` leaves the meeting as it was or finishes later;
    /// the next pull looks again.
    fn update(
        &self,
        meeting: &str,
        swap: &mut dyn FnMut() -> Result<(), SyncError>,
    ) -> Result<(), SyncError>;

    /// Another computer deleted the meeting. True once it is gone here too; false while it can't
    /// go, for instance while a clip of it is being cut. The next pull tries again.
    fn deleted(&self, meeting: &str) -> bool;
}

/// The last pull, for Settings (voice/ui/API.md, `sync.pull`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullInfo {
    /// When the last pull finished, wall ms.
    pub at: Option<u64>,
    pub running: bool,
    /// Why the last pull stopped, in English; `None` after one that finished.
    pub error: Option<String>,
}

/// Starts the `sync-pull` thread.
pub(crate) fn spawn(shared: Arc<Shared>) -> io::Result<()> {
    thread::Builder::new()
        .name("sync-pull".into())
        .spawn(move || {
            background_thread();
            loop {
                let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&shared)));
                match run {
                    Ok(()) => break,
                    Err(panic) => {
                        log::error!("sync pull panicked: {}", panic_text(&panic));
                        {
                            let mut st = shared.lock();
                            st.pull.running = false;
                            st.pull.error = Some("Pulling meetings stopped unexpectedly.".into());
                        }
                        shared.changed();
                        if shared.sleep(Duration::from_secs(5), shared.wakes()) {
                            break;
                        }
                    }
                }
            }
        })
        .map(drop)
}

fn run(shared: &Arc<Shared>) {
    let every = shared.opts.timing.pull_every;
    let mut last: Option<Instant> = None;
    let mut last_place: Option<u64> = None;
    // A key the system wouldn't open: no pull asks for it again until the user changes something,
    // as the worker waits (macOS asks with a dialog each time).
    let mut key_refused: Option<u64> = None;
    loop {
        let seen = shared.wakes();
        let hooks = shared.pull_hooks();
        let due = {
            let mut st = shared.lock();
            if st.stopping {
                return;
            }
            let key_blocked = st.unlocking
                || st.key_unreadable
                || st.blocked.as_ref().is_some_and(|b| b.error.kind.is_key())
                || key_refused == Some(st.generation);
            let ready = hooks.is_some()
                && st.cfg.is_some()
                && !st.moving()
                && !st.restoring
                && !key_blocked;
            let fresh = last_place != Some(st.place);
            let timer = last.is_none_or(|at| at.elapsed() >= every);
            if ready && (st.pull_requested || fresh || timer) {
                st.pull_requested = false;
                st.pull.running = true;
                last_place = Some(st.place);
                Some(st.generation)
            } else {
                None
            }
        };
        if let Some(generation) = due {
            shared.changed();
            let hooks = hooks.expect("checked above");
            let result = pull_once(shared, hooks.as_ref());
            last = Some(Instant::now());
            {
                let mut st = shared.lock();
                st.pull.running = false;
                match &result {
                    Ok(()) => {
                        st.pull.at = Some(shared.now());
                        st.pull.error = None;
                    }
                    Err(e) => {
                        log::info!("sync: pull stopped: {e}");
                        if e.kind.is_key() {
                            key_refused = Some(generation);
                        }
                        st.pull.error = Some(e.message.clone());
                    }
                }
            }
            shared.changed();
            continue;
        }
        let wait = last.map_or(TICK, |at| every.saturating_sub(at.elapsed()));
        if shared.sleep(wait.clamp(Duration::from_millis(10), TICK), seen) {
            return;
        }
    }
}

/// One look at the bucket. A meeting that fails doesn't stop the others; sync moving or turning
/// off does.
pub(crate) fn pull_once(shared: &Shared, hooks: &dyn PullHooks) -> Result<(), SyncError> {
    let (remote, binding) = shared.remote()?;
    let check = || shared.still(&binding);
    let indexes = read_indexes(&remote, &check)?;
    // What every data folder says of each meeting, for versions published at the same time.
    let mut all: std::collections::HashMap<&str, Vec<&IndexEntry>> =
        std::collections::HashMap::new();
    for index in &indexes {
        for entry in &index.meetings {
            all.entry(entry.id.as_str()).or_default().push(entry);
        }
    }
    let entries = merge_indexes(indexes.clone());
    let mut not_here = 0u32;
    for entry in &entries {
        check()?;
        if MeetingId::parse(&entry.id).is_none() {
            continue;
        }
        let others = all.get(entry.id.as_str()).map_or(&[][..], Vec::as_slice);
        match pull_meeting(shared, &remote, &binding, hooks, entry, others) {
            Ok(here) => {
                if !here && !entry.deleted {
                    not_here += 1;
                }
            }
            Err(e) if e.kind == SyncErrorKind::Off => return Err(e),
            Err(e) => {
                log::warn!("sync: can't pull a meeting: {e}");
                if !entry.deleted {
                    not_here += 1;
                }
            }
        }
    }
    let mut st = shared.lock();
    if !st.restoring {
        // What a restore would still bring: meetings that didn't finish, or failed to come in.
        st.restore.available = not_here;
    }
    Ok(())
}

/// The start time a meeting folder's `meeting.json` gives, or `None` without one.
fn local_created_at(dir: &Path) -> Option<u64> {
    let bytes = fs::read(dir.join(voice_meetings::MEETING_FILE)).ok()?;
    serde_json::from_slice::<MeetingFile>(&bytes)
        .ok()
        .map(|m| m.created_at)
}

/// One entry of the merged index, with what each data folder says of the meeting. True when the
/// meeting is on this computer afterwards.
fn pull_meeting(
    shared: &Shared,
    remote: &Remote,
    binding: &Binding,
    hooks: &dyn PullHooks,
    entry: &IndexEntry,
    others: &[&IndexEntry],
) -> Result<bool, SyncError> {
    let id = entry.id.as_str();
    let dir = shared.meeting_dir(id);
    let row = shared.queue.meeting(id)?;
    let created_at = local_created_at(&dir);
    let here = created_at.is_some();
    // An id names a second of a start and a random suffix: two computers can make the same one for
    // different meetings. The bucket's entry speaks of this meeting only when it started at the
    // same millisecond; otherwise it is left alone.
    if here && created_at != Some(entry.created_at) {
        log::warn!("sync: a meeting in the bucket has the id of another one here; both stay");
        return Ok(true);
    }
    let forgotten = row.as_ref().is_some_and(|r| r.phase == "forgotten");
    if entry.deleted {
        // Also when it is forgotten here already: a deletion that stopped halfway goes on.
        return Ok(here && !hooks.deleted(id));
    }
    if forgotten {
        // Deleted here; the next index says so.
        return Ok(here);
    }
    if !here {
        if entry.state != "done" {
            return Ok(false);
        }
        let restored = restore_one(shared, remote, binding, id)?;
        if restored {
            hooks.restored(id);
        }
        return Ok(true);
    }
    let Some(row) = row else {
        // The worker hasn't scanned it yet.
        return Ok(true);
    };
    // Only a meeting whose every file is in the bucket: a change made here that is still on its
    // way up wins once it arrives, with the next generation.
    let settled = matches!(row.phase.as_str(), "synced" | "restored");
    if entry.state != "done" || !settled {
        return Ok(true);
    }
    let mine = shared.queue.manifest_id(id)?;
    // Another data folder published a version at the same generation as this one, from the same
    // starting point: the bucket's manifest is whichever went up last, and both computers take it.
    let concurrent = others
        .iter()
        .any(|e| e.gen == row.uploaded_gen && e.mid.is_some() && mine.is_some() && e.mid != mine);
    if entry.gen > row.uploaded_gen || concurrent || leftover(shared, id) {
        update_one(shared, remote, binding, hooks, id, row.uploaded_gen, mine)?;
    }
    Ok(true)
}

/// Whether a replacement of the meeting's text stopped halfway and waits to finish.
fn leftover(shared: &Shared, id: &str) -> bool {
    update_dir(shared, id).join(INSTALL).is_file()
}

fn update_dir(shared: &Shared, id: &str) -> PathBuf {
    shared
        .opts
        .meetings_dir
        .join(format!("{UPDATE_PREFIX}{id}"))
}

/// Brings newer text of a meeting this computer has: version `local_gen` here, `mine` the
/// manifest it came with.
fn update_one(
    shared: &Shared,
    remote: &Remote,
    binding: &Binding,
    hooks: &dyn PullHooks,
    id: &str,
    local_gen: u64,
    mine: Option<String>,
) -> Result<(), SyncError> {
    let tmp = update_dir(shared, id);
    if tmp.join(INSTALL).is_file() {
        // A replacement stopped halfway: it goes on first, with nothing reading the transcript.
        let meetings = shared.opts.meetings_dir.clone();
        let mut finish = || -> Result<(), SyncError> {
            let _busy = shared.busy();
            finish_install(&meetings, id)
                .map(drop)
                .map_err(|e| local("Voice can't put newer meeting text in place", &e))
        };
        hooks.update(id, &mut finish)?;
    }
    let check = || shared.still(binding);
    let mhash = names::meeting_hash(&remote.name_key, id);
    let object = names::manifest_object(&remote.kid, &mhash);
    check()?;
    let bytes = match open_object(&remote.bucket, &remote.key, &object) {
        Ok(bytes) => bytes,
        Err(e) if e.kind == SyncErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|_| SyncError::new(SyncErrorKind::Crypto, BAD_MANIFEST))?;
    check_manifest(&manifest, id, &remote.kid, &mhash)?;
    let theirs = sha256_hex(&bytes);
    let newer = manifest.gen > local_gen
        || (manifest.gen == local_gen && mine.is_some() && mine.as_deref() != Some(&theirs));
    if !newer || manifest.state != "done" {
        return Ok(());
    }
    let _ = fs::remove_dir_all(&tmp);
    let result = update_from(
        shared, remote, binding, hooks, &manifest, &theirs, id, &mhash, &tmp, local_gen,
    );
    // A replacement that stopped halfway stays for the next pull, or for `open`.
    if !tmp.join(INSTALL).is_file() {
        let _ = fs::remove_dir_all(&tmp);
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn update_from(
    shared: &Shared,
    remote: &Remote,
    binding: &Binding,
    hooks: &dyn PullHooks,
    manifest: &Manifest,
    manifest_id: &str,
    id: &str,
    mhash: &str,
    tmp: &Path,
    local_gen: u64,
) -> Result<(), SyncError> {
    let check = || shared.still(binding);
    let dir = shared.meeting_dir(id);
    let transcript = voice_meetings::transcript::FILE_NAME;
    // What the transcript here says now: a split or another change here while the newer text comes
    // makes the pull stop, and the change goes up instead.
    let ours = crate::digest::transcript_digest(&dir.join(transcript)).ok();
    let mut swap: Vec<String> = Vec::new();
    for file in manifest
        .files
        .iter()
        .filter(|f| TEXT.contains(&f.path.as_str()))
    {
        let have = shared.queue.in_bucket(id, &file.path)?;
        if have.as_ref().is_some_and(|r| r.sha256 == file.sha256) {
            continue;
        }
        if !(shared.opts.reserve)(file.size) {
            return Err(SyncError::new(SyncErrorKind::Local, NO_ROOM));
        }
        let dest = tmp.join(&file.path);
        fetch_to_file(
            &remote.bucket,
            &remote.key,
            &file.object,
            file.size,
            &file.sha256,
            &dest,
            &check,
        )?;
        if file.path == voice_meetings::MEETING_FILE {
            check_meeting_file(&dest, id)?;
        } else if file.path == timeline::FILE_NAME {
            check_timeline(&dest)?;
        } else if file.path == transcript {
            let theirs = crate::digest::transcript_digest(&dest)?;
            shared
                .queue
                .set_transcript_digest(id, &file.sha256, &theirs)?;
            // The same text in other bytes: what another computer's pipeline noted for its own
            // event log. Nothing to change here.
            if ours.as_deref() == Some(theirs.as_str()) {
                continue;
            }
        }
        swap.push(file.path.clone());
    }
    let title = match swap.iter().any(|p| p == voice_meetings::MEETING_FILE) {
        true => check_meeting_file(&tmp.join(voice_meetings::MEETING_FILE), id)?,
        false => check_meeting_file(&dir.join(voice_meetings::MEETING_FILE), id)?,
    };
    let duration_ms = manifest
        .files
        .iter()
        .filter_map(|f| Some(f.t? + samples_to_ms(f.samples?)))
        .max();
    let import = Import {
        meeting: id,
        mhash,
        title: &title.title,
        created_at: title.created_at,
        duration_ms,
        state: &manifest.state,
        gen: manifest.gen,
        media_removed_at: manifest.media_removed_at,
        files: &manifest.files,
        now: shared.now(),
        target: &binding.target,
        kid: &binding.kid,
        update: true,
    };
    // Under `busy`, right before anything changes: the meeting is still at the version the pull
    // started from, with nothing of it on its way up, and its transcript says what it said.
    let unchanged = || -> Result<(), SyncError> {
        check()?;
        let row = shared.queue.meeting(id)?;
        let same = row.is_some_and(|r| {
            r.uploaded_gen == local_gen && matches!(r.phase.as_str(), "synced" | "restored")
        }) && !shared.queue.meeting_waiting(id, true)?
            && crate::digest::transcript_digest(&dir.join(transcript)).ok() == ours;
        if same {
            Ok(())
        } else {
            Err(SyncError::new(
                SyncErrorKind::Local,
                "The meeting changed here while its newer text came.",
            ))
        }
    };
    let record = || -> Result<(), SyncError> {
        if !shared.queue.import(&import)? {
            return Err(SyncError::new(
                SyncErrorKind::Local,
                "Sync hasn't started with this bucket yet.",
            ));
        }
        shared.queue.set_manifest_id(id, manifest_id)?;
        // The index says which version this computer has now.
        shared
            .queue
            .set_meta("index_due", Some(&shared.now().to_string()))
    };
    if swap.is_empty() {
        let _busy = shared.busy();
        unchanged()?;
        return record();
    }
    let meetings = shared.opts.meetings_dir.clone();
    let mut put = || -> Result<(), SyncError> {
        let _busy = shared.busy();
        unchanged()?;
        // From here the replacement goes on to the end, also after a crash.
        write_install(tmp, &swap).map_err(|e| local("Voice can't note newer meeting text", &e))?;
        finish_install(&meetings, id)
            .map_err(|e| local("Voice can't put newer meeting text in place", &e))?;
        record()
    };
    hooks.update(id, &mut put)
}

/// Notes which files of `tmp` replace the meeting's, and marks the meeting as pulled, durably.
fn write_install(tmp: &Path, paths: &[String]) -> io::Result<()> {
    let text = serde_json::to_vec(paths).map_err(io::Error::other)?;
    let path = tmp.join(INSTALL);
    let part = tmp.join(format!("{INSTALL}.part"));
    let mut file = fs::File::create(&part)?;
    file.write_all(&text)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&part, &path)?;
    sync_dir(tmp);
    Ok(())
}

/// Puts the files an update folder's [`INSTALL`] lists in the meeting's place, those not moved
/// yet, then removes the update folder. False without one. The old database's write-ahead log
/// would be read into the new database, so it goes first. Nothing may read or write the meeting's
/// transcript meanwhile.
pub(crate) fn finish_install(meetings: &Path, id: &str) -> io::Result<bool> {
    let tmp = meetings.join(format!("{UPDATE_PREFIX}{id}"));
    let Ok(text) = fs::read(tmp.join(INSTALL)) else {
        return Ok(false);
    };
    let paths: Vec<String> = serde_json::from_slice(&text).map_err(io::Error::other)?;
    let dir = meetings.join(id);
    // Rukoo hears of it once the engine follows the meeting again.
    write_marker(&dir)?;
    for path in &paths {
        if !TEXT.contains(&path.as_str()) {
            continue;
        }
        let from = tmp.join(path);
        if !from.is_file() {
            continue;
        }
        let dest = dir.join(path);
        if path == voice_meetings::transcript::FILE_NAME {
            for suffix in ["-wal", "-shm"] {
                match fs::remove_file(with_suffix(&dest, suffix)) {
                    Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                    _ => {}
                }
            }
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&from, &dest)?;
    }
    sync_dir(&dir);
    fs::remove_file(tmp.join(INSTALL))?;
    let _ = fs::remove_dir_all(&tmp);
    Ok(true)
}

/// The [`PULLED`] file in a meeting folder.
pub(crate) fn write_marker(dir: &Path) -> io::Result<()> {
    let path = dir.join(PULLED);
    if path.is_file() {
        return Ok(());
    }
    fs::File::create(&path)?.sync_all()?;
    sync_dir(dir);
    Ok(())
}

/// A rename in `dir` survives a power cut once the folder itself is flushed; Windows can't open a
/// folder for that, and its renames are durable already.
fn sync_dir(dir: &Path) {
    if !cfg!(windows) {
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}
