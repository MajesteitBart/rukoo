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

use std::fs;
use std::io;
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use voice_protocol::MeetingId;
use voice_recorder::timeline::{self, samples_to_ms};

use crate::manifest::{merge_indexes, IndexEntry, Manifest};
use crate::names;
use crate::queue::Import;
use crate::restore::{
    check_manifest, check_meeting_file, check_timeline, fetch_to_file, open_object, read_indexes,
    restore_one, BAD_MANIFEST, NO_ROOM,
};
use crate::worker::{background_thread, local, panic_text, Binding, Remote, Shared};
use crate::{SyncError, SyncErrorKind};

/// The prefix of the folder in `<meetings>` that newer text waits in before it replaces the old.
/// The library and the worker skip it, and `open` removes one a hard kill left.
pub const UPDATE_PREFIX: &str = ".update-";

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

    /// Newer text of a meeting this computer has waits. The engine stops whatever reads the
    /// meeting's transcript, runs `swap`, which puts the new files in place, and then sends Rukoo
    /// what changed. An error from `swap` leaves the old text, and the next pull tries again.
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
    loop {
        let seen = shared.wakes();
        let hooks = shared.pull_hooks();
        let due = {
            let mut st = shared.lock();
            if st.stopping {
                return;
            }
            let ready = hooks.is_some() && st.cfg.is_some() && !st.moving() && !st.restoring;
            let fresh = last_place != Some(st.place);
            let timer = last.is_none_or(|at| at.elapsed() >= every);
            if ready && (st.pull_requested || fresh || timer) {
                st.pull_requested = false;
                st.pull.running = true;
                last_place = Some(st.place);
                true
            } else {
                false
            }
        };
        if due {
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
    let entries = merge_indexes(read_indexes(&remote, &check)?);
    let mut not_here = 0u32;
    for entry in &entries {
        check()?;
        if MeetingId::parse(&entry.id).is_none() {
            continue;
        }
        match pull_meeting(shared, &remote, &binding, hooks, entry) {
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

/// One entry of the merged index. True when the meeting is on this computer afterwards.
fn pull_meeting(
    shared: &Shared,
    remote: &Remote,
    binding: &Binding,
    hooks: &dyn PullHooks,
    entry: &IndexEntry,
) -> Result<bool, SyncError> {
    let id = entry.id.as_str();
    let row = shared.queue.meeting(id)?;
    let here = shared
        .meeting_dir(id)
        .join(voice_meetings::MEETING_FILE)
        .is_file();
    let forgotten = row.as_ref().is_some_and(|r| r.phase == "forgotten");
    if entry.deleted {
        if here && !forgotten {
            return Ok(!hooks.deleted(id));
        }
        return Ok(here);
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
    if entry.state == "done" && settled && entry.gen > row.uploaded_gen {
        update_one(shared, remote, binding, hooks, id, row.uploaded_gen)?;
    }
    Ok(true)
}

/// Brings newer text of a meeting this computer has.
fn update_one(
    shared: &Shared,
    remote: &Remote,
    binding: &Binding,
    hooks: &dyn PullHooks,
    id: &str,
    local_gen: u64,
) -> Result<(), SyncError> {
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
    if manifest.gen <= local_gen || manifest.state != "done" {
        return Ok(());
    }
    let tmp = shared
        .opts
        .meetings_dir
        .join(format!("{UPDATE_PREFIX}{id}"));
    let _ = fs::remove_dir_all(&tmp);
    let result = update_from(shared, remote, binding, hooks, &manifest, id, &mhash, &tmp);
    let _ = fs::remove_dir_all(&tmp);
    result
}

#[allow(clippy::too_many_arguments)]
fn update_from(
    shared: &Shared,
    remote: &Remote,
    binding: &Binding,
    hooks: &dyn PullHooks,
    manifest: &Manifest,
    id: &str,
    mhash: &str,
    tmp: &Path,
) -> Result<(), SyncError> {
    let check = || shared.still(binding);
    let dir = shared.meeting_dir(id);
    let transcript = voice_meetings::transcript::FILE_NAME;
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
            let ours = crate::digest::transcript_digest(&dir.join(transcript)).ok();
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
    let record = || -> Result<(), SyncError> {
        if shared.queue.import(&import)? {
            Ok(())
        } else {
            Err(SyncError::new(
                SyncErrorKind::Local,
                "Sync hasn't started with this bucket yet.",
            ))
        }
    };
    if swap.is_empty() {
        let _busy = shared.busy();
        check()?;
        return record();
    }
    let mut put = || -> Result<(), SyncError> {
        let _busy = shared.busy();
        check()?;
        let aside = tmp.join(".old");
        fs::create_dir_all(&aside).map_err(|e| local("Voice can't make a folder", &e))?;
        let mut moved: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
        let result = (|| -> Result<(), SyncError> {
            for path in &swap {
                let dest = dir.join(path);
                // The old database's write-ahead log would be read into the new one: it goes
                // aside with it.
                let mut old = vec![dest.clone()];
                if path == transcript {
                    old.push(with_suffix(&dest, "-wal"));
                    old.push(with_suffix(&dest, "-shm"));
                }
                for from in old {
                    if !from.exists() {
                        continue;
                    }
                    let name = from.strip_prefix(&dir).unwrap_or(&from).to_string_lossy();
                    let to = aside.join(name.replace(['/', '\\'], "_"));
                    fs::rename(&from, &to)
                        .map_err(|e| local("Voice can't move older meeting text aside", &e))?;
                    moved.push((from, to));
                }
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| local("Voice can't make a folder", &e))?;
                }
                fs::rename(tmp.join(path), &dest)
                    .map_err(|e| local("Voice can't put newer meeting text in place", &e))?;
            }
            record()
        })();
        if result.is_err() {
            // Back as it was: the next pull tries again.
            for path in &swap {
                let dest = dir.join(path);
                if moved.iter().any(|(from, _)| *from == dest) {
                    let _ = fs::remove_file(&dest);
                }
            }
            for (from, to) in moved.iter().rev() {
                let _ = fs::rename(to, from);
            }
        }
        result
    };
    hooks.update(id, &mut put)
}

fn with_suffix(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}
