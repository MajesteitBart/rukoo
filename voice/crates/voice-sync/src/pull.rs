//! Meetings from the user's other computers (voice/README.md, Storage). Every few minutes, and
//! when the engine asks, the `sync-pull` thread reads the bucket's indexes:
//!
//! - a finished meeting this computer doesn't have comes in as text, the way a restore brings it,
//!   and its media stays in the bucket until something asks for it (`ensure_local`);
//! - newer text of a meeting this computer has, such as a microphone split another computer made,
//!   replaces the old text once the transcript says something else;
//! - a meeting another computer deleted is deleted here too.
//!
//! The engine does the parts that touch its pipelines and event log through [`PullHooks`]. The pull
//! uses the worker's connection, so it never reads the key or the secret itself: on macOS each
//! read can ask the user.
//!
//! Newer text goes in place in three steps. It comes down into `.update-<id>/files/`; then, with
//! nothing reading the transcript, an `install.json` names the files to move and they move; then the
//! queue notes the version. The note survives a crash: `open` moves what is left, and until a pull
//! noted the version, the worker leaves the meeting alone, so it never sends the newer text back as
//! a change of its own.
//!
//! A meeting that came in or changed this way gets a [`PULLED`] file in its folder in the same step.
//! The engine follows such a meeting until its event log has all of it and then removes the file,
//! so a Voice that quits in between still tells Rukoo at its next start.

use std::collections::HashMap;
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

/// In an update folder: the files listed here replace the meeting's, and the replacement goes on
/// to the end, also after a crash. It stays until the queue noted the new version.
const INSTALL: &str = "install.json";

/// In an update folder: where the newer files come down.
const FILES: &str = "files";

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

    /// Newer text of a meeting this computer has waits. The engine holds off whatever reads or
    /// writes the meeting's transcript, runs `swap`, which puts the new files in place, and then
    /// sends Rukoo what changed. An error from `swap` leaves the meeting as it was or finishes
    /// later; the next pull looks again.
    fn update(
        &self,
        meeting: &str,
        swap: &mut dyn FnMut() -> Result<(), SyncError>,
    ) -> Result<(), SyncError>;

    /// Another computer deleted the meeting. True once it is gone here too; false while it can't
    /// go, for instance while a clip of it is being cut. The next pull tries again. The engine
    /// passes `from` to [`BucketSync::mark_deleted`](crate::BucketSync::mark_deleted), which
    /// notes the deletion only while sync still uses the bucket and key the pull read it from.
    fn deleted(&self, meeting: &str, from: &PullOrigin<'_>) -> bool;
}

/// The bucket and key a pull read a deletion from.
pub struct PullOrigin<'a> {
    pub(crate) shared: &'a Shared,
    pub(crate) place: u64,
}

impl PullOrigin<'_> {
    /// True while sync still uses that bucket and key. Only a hint: settings can change right
    /// after; [`BucketSync::mark_deleted`](crate::BucketSync::mark_deleted) checks again.
    pub fn holds(&self) -> bool {
        self.shared.lock().uses(self.place)
    }
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
        // Only over the worker's connection for the current settings: the key and the secret were
        // read once for them.
        let connected = shared.connected();
        let (ready, due) = {
            let mut st = shared.lock();
            if st.stopping {
                return;
            }
            // The connection, and the bucket and key it reads, are those sync uses now.
            let ready = hooks.is_some()
                && st.cfg.is_some()
                && !st.moving()
                && !st.restoring
                && connected.as_ref().is_some_and(|c| {
                    c.generation == st.generation && c.binding.place() == st.place
                });
            let fresh = last_place != Some(st.place);
            let timer = last.is_none_or(|at| at.elapsed() >= every);
            if ready && (st.pull_requested || fresh || timer) {
                st.pull_requested = false;
                st.pull.running = true;
                last_place = Some(st.place);
                (true, true)
            } else {
                (ready, false)
            }
        };
        if !due {
            // Not ready: a change wakes the thread, else it looks again in a second. Ready but not
            // due: it waits until the next pull is.
            let wait = match (ready, last) {
                (true, Some(at)) => every
                    .saturating_sub(at.elapsed())
                    .clamp(Duration::from_millis(50), TICK),
                _ => TICK,
            };
            if shared.sleep(wait, seen) {
                return;
            }
            continue;
        }
        shared.changed();
        let hooks = hooks.expect("checked above");
        let connected = connected.expect("checked above");
        let result = pull_once(
            shared,
            hooks.as_ref(),
            &connected.remote,
            &connected.binding,
        );
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
    }
}

/// One look at the bucket. A meeting that fails doesn't stop the others; sync moving or turning
/// off does.
pub(crate) fn pull_once(
    shared: &Shared,
    hooks: &dyn PullHooks,
    remote: &Remote,
    binding: &Binding,
) -> Result<(), SyncError> {
    let check = || shared.still(binding);
    // Replacements that stopped before their version was noted go first, from disk: they hold
    // their meetings out of uploads, whatever the bucket's indexes say now.
    for id in pending_installs(&shared.opts.meetings_dir) {
        check()?;
        if let Err(e) = settle_install(shared, binding, hooks, &id) {
            if e.kind == SyncErrorKind::Off {
                return Err(e);
            }
            log::warn!("sync: can't finish a meeting's newer text: {e}");
        }
    }
    let indexes = read_indexes(remote, &check)?;
    // What every data folder says of each meeting: two meetings can share an id, and two computers
    // can publish the same generation.
    let mut all: HashMap<&str, Vec<&IndexEntry>> = HashMap::new();
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
        match pull_meeting(shared, remote, binding, hooks, entry, others) {
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

fn origin<'a>(shared: &'a Shared, binding: &Binding) -> PullOrigin<'a> {
    PullOrigin {
        shared,
        place: binding.place(),
    }
}

/// The start time a `meeting.json` gives, or `None` without a readable one.
fn created_at_of(path: &Path) -> Option<u64> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<MeetingFile>(&bytes)
        .ok()
        .map(|m| m.created_at)
}

/// The folder of a deletion that started here and stopped before it removed the folder.
fn pending_deletion(shared: &Shared, id: &str) -> PathBuf {
    shared.opts.meetings_dir.join(format!(".deleted-{id}"))
}

/// One meeting of the merged index, with what each data folder says of it. True when the meeting
/// is on this computer afterwards.
fn pull_meeting(
    shared: &Shared,
    remote: &Remote,
    binding: &Binding,
    hooks: &dyn PullHooks,
    merged: &IndexEntry,
    others: &[&IndexEntry],
) -> Result<bool, SyncError> {
    let id = merged.id.as_str();
    let dir = shared.meeting_dir(id);
    let created_at = created_at_of(&dir.join(voice_meetings::MEETING_FILE));
    let here = created_at.is_some();
    if !here {
        let pending = pending_deletion(shared, id);
        if pending.is_dir() {
            // A deletion that stopped halfway, here or for another computer's tombstone: it goes on
            // when the bucket says this meeting is deleted.
            let same = created_at_of(&pending.join(voice_meetings::MEETING_FILE))
                .is_none_or(|at| others.iter().any(|e| e.deleted && e.created_at == at));
            if same && merged.deleted {
                hooks.deleted(id, &origin(shared, binding));
            }
            return Ok(false);
        }
        if merged.deleted || merged.state != "done" {
            return Ok(false);
        }
        // Deleted here while offline: the bucket doesn't know yet, and it stays deleted.
        if shared
            .queue
            .meeting(id)?
            .is_some_and(|r| r.phase == "forgotten")
        {
            return Ok(false);
        }
        let restored = restore_one(shared, remote, binding, id)?;
        if restored {
            hooks.restored(id);
        }
        return Ok(true);
    }
    // An id names a second of a start and a random suffix: two computers can make the same one for
    // different meetings. Only what the bucket says of the meeting that started at this
    // millisecond counts here.
    let mine: Vec<&IndexEntry> = others
        .iter()
        .copied()
        .filter(|e| Some(e.created_at) == created_at)
        .collect();
    let Some(entry) = mine.iter().copied().max_by_key(|e| (e.deleted, e.gen)) else {
        if !others.is_empty() {
            log::warn!("sync: a meeting in the bucket has the id of another one here; both stay");
        }
        return Ok(true);
    };
    if entry.deleted {
        // Also when it is forgotten here already: a deletion that stopped halfway goes on. Only
        // while the tombstone is from the bucket sync uses now.
        return Ok(!hooks.deleted(id, &origin(shared, binding)));
    }
    let row = shared.queue.meeting(id)?;
    if row.as_ref().is_some_and(|r| r.phase == "forgotten") {
        // Deleted here; the next index says so.
        return Ok(true);
    }
    let Some(row) = row else {
        // The worker hasn't scanned it yet.
        return Ok(true);
    };
    if pending_install(&shared.opts.meetings_dir, id) {
        // A replacement put its files in place before a crash: its version is noted now.
        settle_install(shared, binding, hooks, id)?;
        return Ok(true);
    }
    // Only a meeting whose every file is in the bucket: a change made here that is still on its
    // way up wins once it arrives, with the next generation.
    let settled = matches!(row.phase.as_str(), "synced" | "restored");
    if entry.state != "done" || !settled {
        return Ok(true);
    }
    let own = shared.queue.manifest_id(id)?;
    // Another data folder published a version at the same generation as this one, from the same
    // starting point: the bucket's manifest is whichever went up last, and both computers take it.
    let concurrent = mine
        .iter()
        .any(|e| e.gen == row.uploaded_gen && e.mid.is_some() && own.is_some() && e.mid != own);
    if entry.gen > row.uploaded_gen || concurrent {
        update_one(
            shared,
            remote,
            binding,
            hooks,
            id,
            row.uploaded_gen,
            own,
            created_at,
        )?;
    }
    Ok(true)
}

/// The meetings whose replacement stopped before its version was noted.
fn pending_installs(meetings: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(meetings) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let id = name.strip_prefix(UPDATE_PREFIX)?;
            (MeetingId::parse(id).is_some() && pending_install(meetings, id)).then(|| id.to_owned())
        })
        .collect()
}

/// Whether newer text of the meeting is in place but its version isn't noted yet. The worker
/// leaves such a meeting alone until a pull noted it.
pub fn pending_install(meetings: &Path, id: &str) -> bool {
    meetings
        .join(format!("{UPDATE_PREFIX}{id}"))
        .join(INSTALL)
        .is_file()
}

fn update_dir(shared: &Shared, id: &str) -> PathBuf {
    shared
        .opts
        .meetings_dir
        .join(format!("{UPDATE_PREFIX}{id}"))
}

/// Brings newer text of a meeting this computer has: version `local_gen` here, `own` the
/// manifest it came with, `created_at` the meeting's start.
#[allow(clippy::too_many_arguments)]
fn update_one(
    shared: &Shared,
    remote: &Remote,
    binding: &Binding,
    hooks: &dyn PullHooks,
    id: &str,
    local_gen: u64,
    own: Option<String>,
    created_at: Option<u64>,
) -> Result<(), SyncError> {
    let tmp = update_dir(shared, id);
    if tmp.join(INSTALL).is_file() {
        // A replacement that started is settled from its journal, never fetched over.
        return Ok(());
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
        || (manifest.gen == local_gen && own.is_some() && own.as_deref() != Some(&theirs));
    if !newer || manifest.state != "done" {
        return Ok(());
    }
    let files = tmp.join(FILES);
    let _ = fs::remove_dir_all(&files);
    let result = update_from(
        shared, remote, binding, hooks, &manifest, &theirs, id, &mhash, &tmp, local_gen, created_at,
    );
    // Whatever came down goes; a replacement that started stays whole, its files too, for the next
    // pull or for `open`, until the queue noted its version.
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
    created_at: Option<u64>,
) -> Result<(), SyncError> {
    let check = || shared.still(binding);
    let dir = shared.meeting_dir(id);
    let files = tmp.join(FILES);
    let transcript = voice_meetings::transcript::FILE_NAME;
    let digest_here = || crate::digest::transcript_digest(&dir.join(transcript)).ok();
    // What the transcript here says now, and what it said as this computer last synced it. A
    // difference is a change made here, such as a split, that hasn't gone up yet: it goes up
    // instead, and the next pull looks again.
    let ours = digest_here();
    let recorded = || -> Result<Option<String>, SyncError> {
        let Some(row) = shared.queue.in_bucket(id, transcript)? else {
            return Ok(None);
        };
        shared.queue.transcript_digest(id, &row.sha256)
    };
    let changed_here = |now: &Option<String>| -> Result<bool, SyncError> {
        Ok(matches!((recorded()?, now), (Some(r), Some(n)) if r != *n))
    };
    if changed_here(&ours)? {
        shared.rescan_soon();
        return Err(SyncError::new(
            SyncErrorKind::Local,
            "The meeting changed here and its change hasn't gone up yet.",
        ));
    }
    let mut swap: Vec<String> = Vec::new();
    // What the version's transcript says, as it came down: recovery notes it, never what the
    // transcript here says by then.
    let mut transcript_digest: Option<String> = None;
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
        let dest = files.join(&file.path);
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
            // The same id can name another computer's meeting: its text never lands here.
            let fetched = check_meeting_file(&dest, id)?;
            if Some(fetched.created_at) != created_at {
                return Err(SyncError::new(
                    SyncErrorKind::Crypto,
                    "The bucket's newer text is of another meeting with the same id.",
                ));
            }
        } else if file.path == timeline::FILE_NAME {
            check_timeline(&dest)?;
        } else if file.path == transcript {
            let theirs = crate::digest::transcript_digest(&dest)?;
            shared
                .queue
                .set_transcript_digest(id, &file.sha256, &theirs)?;
            transcript_digest = Some(theirs.clone());
            // The same text in other bytes: what another computer's pipeline noted for its own
            // event log. Nothing to change here.
            if ours.as_deref() == Some(theirs.as_str()) {
                continue;
            }
        }
        swap.push(file.path.clone());
    }
    let title_file = match swap.iter().any(|p| p == voice_meetings::MEETING_FILE) {
        true => files.join(voice_meetings::MEETING_FILE),
        false => dir.join(voice_meetings::MEETING_FILE),
    };
    let journal = Journal {
        paths: swap.clone(),
        manifest: manifest.clone(),
        manifest_id: manifest_id.to_owned(),
        mhash: mhash.to_owned(),
        target: binding.target.clone(),
        kid: binding.kid.clone(),
        transcript_digest,
    };
    check_meeting_file(&title_file, id)?;
    // The downloads are on disk, names included, up to the update folder's own name in the
    // library, before the journal says to move them: a move that survives a power cut then always
    // has its journal.
    let root = &shared.opts.meetings_dir;
    let mut folders = std::collections::BTreeSet::new();
    for path in &swap {
        let mut at = files.join(path).parent().map(Path::to_path_buf);
        while let Some(folder) = at {
            if !folder.starts_with(root) || !folders.insert(folder.clone()) {
                break;
            }
            at = folder
                .parent()
                .filter(|_| folder != *root)
                .map(Path::to_path_buf);
        }
    }
    // Deepest first, so a folder is flushed after the names in it.
    for folder in folders.iter().rev() {
        sync_dir(folder).map_err(|e| local("Voice can't keep newer meeting text", &e))?;
    }
    // Under `busy`, right before anything changes: the meeting is still at the version the pull
    // started from, with nothing of it on its way up, and its transcript says what it said.
    let unchanged = || -> Result<(), SyncError> {
        check()?;
        let row = shared.queue.meeting(id)?;
        let now = digest_here();
        let same = row.is_some_and(|r| {
            r.uploaded_gen == local_gen && matches!(r.phase.as_str(), "synced" | "restored")
        }) && !shared.queue.meeting_waiting(id, true)?
            && now == ours
            && !changed_here(&now)?;
        if same {
            Ok(())
        } else {
            shared.rescan_soon();
            Err(SyncError::new(
                SyncErrorKind::Local,
                "The meeting changed here while its newer text came.",
            ))
        }
    };
    if swap.is_empty() {
        let _busy = shared.busy();
        unchanged()?;
        return record(shared, id, &journal, &title_file);
    }
    let meetings = shared.opts.meetings_dir.clone();
    let installed = dir.join(voice_meetings::MEETING_FILE);
    let mut put = || -> Result<(), SyncError> {
        let _busy = shared.busy();
        unchanged()?;
        // From here the replacement goes on to the end, also after a crash.
        write_install(tmp, &journal)
            .map_err(|e| local("Voice can't note newer meeting text", &e))?;
        finish_install(&meetings, id)
            .map_err(|e| local("Voice can't put newer meeting text in place", &e))?;
        record(shared, id, &journal, &installed)?;
        let _ = fs::remove_dir_all(tmp);
        Ok(())
    };
    hooks.update(id, &mut put)
}

/// What an update folder's [`INSTALL`] holds: the files that replace the meeting's, and the version
/// they are, with the bucket and the key it is in, so it can be noted without the bucket.
#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    paths: Vec<String>,
    manifest: Manifest,
    manifest_id: String,
    mhash: String,
    target: String,
    kid: String,
    /// What the downloaded transcript says ([`crate::digest`]), when one came down.
    #[serde(default)]
    transcript_digest: Option<String>,
}

fn read_journal(tmp: &Path) -> io::Result<Option<Journal>> {
    match fs::read(tmp.join(INSTALL)) {
        Ok(text) => serde_json::from_slice(&text)
            .map(Some)
            .map_err(io::Error::other),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Notes the version a journal names in the queue, durably, and only then removes the journal: the
/// replacement counts as done.
fn record(
    shared: &Shared,
    id: &str,
    journal: &Journal,
    title_file: &Path,
) -> Result<(), SyncError> {
    let title = check_meeting_file(title_file, id)?;
    let manifest = &journal.manifest;
    let duration_ms = manifest
        .files
        .iter()
        .filter_map(|f| Some(f.t? + samples_to_ms(f.samples?)))
        .max();
    let import = Import {
        meeting: id,
        mhash: &journal.mhash,
        title: &title.title,
        created_at: title.created_at,
        duration_ms,
        state: &manifest.state,
        gen: manifest.gen,
        media_removed_at: manifest.media_removed_at,
        files: &manifest.files,
        now: shared.now(),
        target: &journal.target,
        kid: &journal.kid,
        update: true,
    };
    // What the version's transcript says, as it came down: following it here isn't a change to
    // send, and a change made here since, such as a split, still goes up.
    let transcript = voice_meetings::transcript::FILE_NAME;
    if let (Some(file), Some(digest)) = (
        manifest.files.iter().find(|f| f.path == transcript),
        &journal.transcript_digest,
    ) {
        shared
            .queue
            .set_transcript_digest(id, &file.sha256, digest)?;
    }
    if !shared.queue.import(&import)? {
        return Err(SyncError::new(
            SyncErrorKind::Local,
            "Sync hasn't started with this bucket yet.",
        ));
    }
    shared.queue.set_manifest_id(id, &journal.manifest_id)?;
    // The index says which version this computer has now.
    shared
        .queue
        .set_meta("index_due", Some(&shared.now().to_string()))?;
    // On disk before the journal goes: a power cut must not leave the newer text unnoted.
    shared.queue.checkpoint()?;
    let tmp = shared
        .opts
        .meetings_dir
        .join(format!("{UPDATE_PREFIX}{id}"));
    match fs::remove_file(tmp.join(INSTALL)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(local(
            "Voice can't finish putting newer meeting text in place",
            &e,
        )),
        _ => Ok(()),
    }
}

/// A replacement that stopped before its version was noted: the files that weren't moved move,
/// with nothing reading the transcript, and the version the journal names is noted. A journal of
/// another bucket or key only lets the meeting go: its text is this computer's own now, and goes up
/// to the bucket sync uses.
fn settle_install(
    shared: &Shared,
    binding: &Binding,
    hooks: &dyn PullHooks,
    id: &str,
) -> Result<(), SyncError> {
    let meetings = shared.opts.meetings_dir.clone();
    let tmp = meetings.join(format!("{UPDATE_PREFIX}{id}"));
    let Some(journal) =
        read_journal(&tmp).map_err(|e| local("Voice can't read a meeting's update", &e))?
    else {
        return Ok(());
    };
    if journal.target != binding.target || journal.kid != binding.kid {
        let _ = fs::remove_dir_all(&tmp);
        shared.rescan_soon();
        return Ok(());
    }
    let installed = meetings.join(id).join(voice_meetings::MEETING_FILE);
    let mut finish = || -> Result<(), SyncError> {
        let _busy = shared.busy();
        shared.still(binding)?;
        match finish_install(&meetings, id) {
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                // A file of the version is neither staged nor in place: the meeting holds text of
                // two versions. It is this computer's own now and goes up as a change.
                log::warn!("sync: a meeting's newer text didn't all arrive; its text here goes up");
                let _ = fs::remove_dir_all(&tmp);
                shared.rescan_soon();
                return Ok(());
            }
            Err(e) => return Err(local("Voice can't put newer meeting text in place", &e)),
        }
        record(shared, id, &journal, &installed)?;
        let _ = fs::remove_dir_all(&tmp);
        Ok(())
    };
    hooks.update(id, &mut finish)
}

/// Lets go of a meeting whose replacement stopped for a bucket or key sync no longer uses: its text
/// is this computer's own now. True when it did, or there is nothing to let go.
pub(crate) fn release_elsewhere(
    meetings: &Path,
    id: &str,
    target: Option<&str>,
    kid: Option<&str>,
) -> bool {
    let tmp = meetings.join(format!("{UPDATE_PREFIX}{id}"));
    match read_journal(&tmp) {
        Ok(None) => true,
        Ok(Some(journal))
            if Some(journal.target.as_str()) != target || Some(journal.kid.as_str()) != kid =>
        {
            fs::remove_dir_all(&tmp).is_ok()
        }
        _ => false,
    }
}

/// Notes which files of the update folder replace the meeting's, and which version they are,
/// durably.
fn write_install(tmp: &Path, journal: &Journal) -> io::Result<()> {
    let text = serde_json::to_vec(journal).map_err(io::Error::other)?;
    let path = tmp.join(INSTALL);
    let part = tmp.join(format!("{INSTALL}.part"));
    let mut file = fs::File::create(&part)?;
    file.write_all(&text)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&part, &path)?;
    sync_dir(tmp)
}

/// Moves the files an update folder's [`INSTALL`] lists into the meeting's place, those not moved
/// yet, and marks the meeting as pulled. False without an [`INSTALL`]. The old database's
/// write-ahead log would be read into the new database, so it goes first. Nothing may read or write
/// the meeting's transcript meanwhile. The [`INSTALL`] stays until the queue noted the version.
pub(crate) fn finish_install(meetings: &Path, id: &str) -> io::Result<bool> {
    let tmp = meetings.join(format!("{UPDATE_PREFIX}{id}"));
    let text = match fs::read(tmp.join(INSTALL)) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    let journal: Journal = serde_json::from_slice(&text).map_err(io::Error::other)?;
    let paths = &journal.paths;
    let dir = meetings.join(id);
    // Rukoo hears of it once the engine follows the meeting again.
    write_marker(&dir)?;
    let files = tmp.join(FILES);
    for path in paths {
        if !TEXT.contains(&path.as_str()) {
            continue;
        }
        let from = files.join(path);
        let dest = dir.join(path);
        if !from.is_file() {
            // Moved before the crash, when what is in place is the version's file.
            let wanted = journal
                .manifest
                .files
                .iter()
                .find(|f| f.path == *path)
                .map(|f| f.sha256.as_str());
            let have = crate::worker::sha256_file(&dest).ok().map(|(sha, _)| sha);
            if wanted.is_none() || have.as_deref() != wanted {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "a file of the newer version is neither staged nor in place",
                ));
            }
            continue;
        }
        if path == voice_meetings::transcript::FILE_NAME {
            for suffix in ["-wal", "-shm"] {
                match fs::remove_file(with_suffix(&dest, suffix)) {
                    Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                    _ => {}
                }
            }
        }
        let parent = dest.parent().unwrap_or(&dir);
        fs::create_dir_all(parent)?;
        fs::rename(&from, &dest)?;
        sync_dir(parent)?;
    }
    sync_dir(&dir)?;
    Ok(true)
}

/// The [`PULLED`] file in a meeting folder.
pub(crate) fn write_marker(dir: &Path) -> io::Result<()> {
    let path = dir.join(PULLED);
    if path.is_file() {
        return Ok(());
    }
    fs::File::create(&path)?.sync_all()?;
    sync_dir(dir)
}

/// A rename in `dir` survives a power cut once the folder itself is flushed. Windows can't open a
/// folder for that, and its renames are durable already.
fn sync_dir(dir: &Path) -> io::Result<()> {
    if cfg!(windows) {
        return Ok(());
    }
    fs::File::open(dir)?.sync_all()
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}
