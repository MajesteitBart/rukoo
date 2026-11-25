//! Meeting media that comes back from the user's bucket in the background (voice/README.md,
//! Storage): the frame images of a meeting Rukoo opens (`media.prefetch`), everything of a meeting
//! the user keeps on this computer (`media.keep`), and the cache limit on what came back.
//!
//! One `media-behind` thread fetches one file at a time in the platform's background mode, and
//! waits while `media.open` prepares something, so what Rukoo asks for now goes first. A task
//! stops when its meeting is deleted, when sync can't fetch, or, for a kept meeting, when the user
//! no longer keeps it. Kept meetings that aren't complete are queued again at start and at every
//! retention sweep.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use voice_bridge::ControlError;
use voice_meetings::MediaPart;
use voice_sync::BucketSync;

use crate::media::MediaService;
use crate::meetings::controller::Controller;

/// How long [`MediaCache::forget`] waits for the fetch of a meeting that is being deleted.
const FORGET_WAIT: Duration = Duration::from_secs(10);
/// While `media.open` prepares, the background fetch looks again this often.
const YIELD: Duration = Duration::from_millis(100);
/// A kept meeting whose download stalled is tried again at most this often when Rukoo asks how it
/// stands.
const RETRY_STALLED: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Eq)]
enum Task {
    /// The meeting's frame images.
    Frames(String),
    /// All of the meeting's media: the user keeps it on this computer.
    All(String),
}

impl Task {
    fn meeting(&self) -> &str {
        match self {
            Task::Frames(id) | Task::All(id) => id,
        }
    }
}

#[derive(Default)]
struct Inner {
    queue: VecDeque<Task>,
    running: bool,
    /// The meeting the thread fetches for now, and the flag that stops that fetch.
    current: Option<(String, Arc<AtomicBool>)>,
    /// Kept meetings whose download stopped before it was complete, and when.
    stalled: HashMap<String, Instant>,
    /// Meetings being deleted: nothing is queued for them again.
    forgotten: HashSet<String>,
}

/// Background fetches and the cache limit.
pub struct MediaCache {
    sync: Option<Arc<BucketSync>>,
    controller: Arc<Controller>,
    media: Weak<MediaService>,
    /// Bytes; 0 until the engine sets it from Settings.
    limit: AtomicU64,
    /// Bytes a frame fetched ahead made room for and is fetching now: every trim leaves room for
    /// them, so what Rukoo fetches meanwhile can't take that room.
    reserved: AtomicU64,
    inner: Mutex<Inner>,
    idle: Condvar,
    stopping: AtomicBool,
    this: Weak<MediaCache>,
}

impl MediaCache {
    pub(crate) fn new(
        sync: Option<Arc<BucketSync>>,
        controller: Arc<Controller>,
        media: Weak<MediaService>,
    ) -> Arc<MediaCache> {
        Arc::new_cyclic(|this| MediaCache {
            sync,
            controller,
            media,
            limit: AtomicU64::new(0),
            reserved: AtomicU64::new(0),
            inner: Mutex::new(Inner::default()),
            idle: Condvar::new(),
            stopping: AtomicBool::new(false),
            this: this.clone(),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The cache limit in bytes, from Settings > Storage.
    pub fn set_limit(&self, bytes: u64) {
        self.limit.store(bytes, Ordering::SeqCst);
    }

    /// Removes fetched media over the limit, least recently used first (voice-sync
    /// `trim_cache`), except what a media job reads now, and keeps room for a frame being
    /// fetched ahead. Nothing before the engine set a limit.
    pub fn trim(&self) -> u64 {
        let limit = self.limit.load(Ordering::SeqCst);
        match &self.sync {
            Some(sync) if limit > 0 => sync.trim_cache(
                limit.saturating_sub(self.reserved.load(Ordering::SeqCst)),
                &|meeting, path| self.in_use(meeting, path),
            ),
            _ => 0,
        }
    }

    /// Whether a media job reads the meeting's file now.
    fn in_use(&self, meeting: &str, path: &str) -> bool {
        self.media
            .upgrade()
            .is_some_and(|media| media.in_use(meeting, path))
    }

    /// Bytes of fetched media the limit counts now.
    pub fn bytes(&self) -> u64 {
        self.sync.as_ref().map_or(0, |sync| sync.cache_bytes())
    }

    /// `media.prefetch`: queues the meeting's frame images that aren't on this computer. Without
    /// sync, or while it can't fetch, nothing happens.
    pub fn prefetch_frames(&self, meeting: &str) -> Result<Value, ControlError> {
        self.meeting_exists(meeting)?;
        if self.sync.as_ref().is_some_and(|sync| sync.can_fetch()) {
            self.push(Task::Frames(meeting.to_owned()));
        }
        Ok(json!({}))
    }

    /// `media.keep`: with `keep`, stores the choice and starts or stops the download; then how it
    /// stands.
    pub fn keep(&self, meeting: &str, keep: Option<bool>) -> Result<Value, ControlError> {
        self.meeting_exists(meeting)?;
        if let Some(keep) = keep {
            let Some(sync) = &self.sync else {
                return Err(ControlError::not_available(
                    "Keeping media on this computer needs bucket sync.",
                ));
            };
            sync.set_kept(meeting, keep)
                .map_err(|e| ControlError::failed(e.message))?;
            if keep {
                self.lock().stalled.remove(meeting);
                self.push(Task::All(meeting.to_owned()));
            } else {
                self.lock().stalled.remove(meeting);
                // What the meeting fetched counts against the limit again.
                self.trim_soon();
            }
        }
        Ok(self.state(meeting))
    }

    /// `{ keep, have, total, stalled }`: whether the user keeps the meeting, the bytes of its
    /// media on this computer and in all, and whether a kept meeting's download waits for the
    /// bucket. Asking about a stalled download tries it again now and then.
    fn state(&self, meeting: &str) -> Value {
        let kept = self
            .sync
            .as_ref()
            .is_some_and(|sync| sync.kept().iter().any(|id| id == meeting));
        let (have, total) = self.sizes(meeting);
        let mut stalled = false;
        if kept && have < total {
            let can_fetch = self.sync.as_ref().is_some_and(|sync| sync.can_fetch());
            let retry = {
                let inner = self.lock();
                let busy = inner.current.as_ref().is_some_and(|(id, _)| id == meeting)
                    || inner.queue.iter().any(|t| t.meeting() == meeting);
                let since = inner.stalled.get(meeting).copied();
                stalled = !can_fetch || since.is_some();
                !busy && can_fetch && since.is_none_or(|at| at.elapsed() >= RETRY_STALLED)
            };
            if retry {
                self.push(Task::All(meeting.to_owned()));
            }
        }
        json!({ "keep": kept, "have": have, "total": total, "stalled": stalled })
    }

    /// Bytes of the meeting's media on this computer, and in all: what is here plus what only the
    /// bucket has.
    fn sizes(&self, meeting: &str) -> (u64, u64) {
        let Some(dir) = self.controller.library().dir(meeting) else {
            return (0, 0);
        };
        let mut sizes: HashMap<String, u64> = HashMap::new();
        for part in MediaPart::ORDER {
            for path in part.files(dir.path()) {
                if let Ok(meta) = fs::metadata(dir.path().join(&path)) {
                    sizes.insert(path, meta.len());
                }
            }
        }
        let have = sizes.values().sum();
        let only_bucket: u64 = self
            .sync
            .as_ref()
            .map(|sync| sync.media_in_bucket(meeting))
            .unwrap_or_default()
            .into_iter()
            .filter(|(path, _)| !sizes.contains_key(path))
            .map(|(_, bytes)| bytes)
            .sum();
        (have, have + only_bucket)
    }

    /// Kept meetings that miss media are queued again: at start and at each retention sweep.
    pub fn resume(&self) {
        let Some(sync) = &self.sync else {
            return;
        };
        if !sync.can_fetch() {
            return;
        }
        for meeting in sync.kept() {
            let (have, total) = self.sizes(&meeting);
            if have < total {
                self.push(Task::All(meeting));
            }
        }
    }

    /// The meeting is being deleted: its queued fetches go, and a fetch for it now stops first.
    /// `busy` when that fetch doesn't stop in time; the meeting then stays as it was, so later
    /// prefetches and keeps of it work.
    pub(crate) fn forget(&self, meeting: &str) -> Result<(), ControlError> {
        self.forget_within(meeting, FORGET_WAIT)
    }

    fn forget_within(&self, meeting: &str, wait: Duration) -> Result<(), ControlError> {
        let mut inner = self.lock();
        inner.forgotten.insert(meeting.to_owned());
        inner.queue.retain(|t| t.meeting() != meeting);
        inner.stalled.remove(meeting);
        let deadline = Instant::now() + wait;
        while let Some((current, cancel)) = inner.current.as_ref() {
            if current != meeting {
                break;
            }
            cancel.store(true, Ordering::SeqCst);
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                // The deletion doesn't go ahead: nothing may stay refused for the meeting.
                inner.forgotten.remove(meeting);
                return Err(ControlError::new(
                    voice_protocol::ErrorCode::Busy,
                    "Voice is still fetching this meeting's media. Try deleting it again in a moment.",
                ));
            }
            inner = self
                .idle
                .wait_timeout(inner, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        Ok(())
    }

    /// Undoes [`forget`](Self::forget) for a deletion that didn't go ahead. The fetches it
    /// dropped come back with the next prefetch, sweep or keep.
    pub(crate) fn unforget(&self, meeting: &str) {
        self.lock().forgotten.remove(meeting);
    }

    /// Stops the background fetch at its next step.
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let mut inner = self.lock();
        inner.queue.clear();
        if let Some((_, cancel)) = &inner.current {
            cancel.store(true, Ordering::SeqCst);
        }
    }

    fn meeting_exists(&self, meeting: &str) -> Result<(), ControlError> {
        if self.lock().forgotten.contains(meeting)
            || self.controller.library().dir(meeting).is_none()
        {
            return Err(ControlError::not_found("There is no meeting with that id."));
        }
        Ok(())
    }

    /// Trims on a thread of its own, so the caller never waits for the files it removes.
    fn trim_soon(&self) {
        let Some(this) = self.this.upgrade() else {
            return;
        };
        let _ = thread::Builder::new()
            .name("media-trim".into())
            .spawn(move || {
                this.trim();
            });
    }

    /// Queues a task unless the same one waits or runs, and starts the thread when none runs.
    fn push(&self, task: Task) {
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        let spawn = {
            let mut inner = self.lock();
            if inner.forgotten.contains(task.meeting()) || inner.queue.contains(&task) {
                return;
            }
            inner.queue.push_back(task);
            !std::mem::replace(&mut inner.running, true)
        };
        if spawn {
            let this = self.this.clone();
            let started = thread::Builder::new()
                .name("media-behind".into())
                .spawn(move || run_loop(this));
            if started.is_err() {
                let mut inner = self.lock();
                inner.running = false;
                inner.queue.clear();
            }
        }
    }

    /// Fetches the task's files that aren't on this computer, one at a time. Whether it stopped
    /// before it was done for a reason that can pass: sync couldn't fetch, or a fetch failed.
    fn run(&self, task: &Task, cancel: &AtomicBool) -> bool {
        let Some(sync) = &self.sync else {
            return false;
        };
        let meeting = task.meeting();
        let rank = |path: &str| {
            ["audio/", "screen/frames/", "screen/video/"]
                .iter()
                .position(|dir| path.starts_with(dir))
                .unwrap_or(3)
        };
        let mut files: Vec<(String, u64)> = sync
            .media_in_bucket(meeting)
            .into_iter()
            .filter(|(path, _)| match task {
                Task::Frames(_) => path.starts_with("screen/frames/"),
                Task::All(_) => true,
            })
            .collect();
        files.sort_by(|(a, _), (b, _)| rank(a).cmp(&rank(b)).then_with(|| a.cmp(b)));
        let stop = || self.stopping.load(Ordering::SeqCst) || cancel.load(Ordering::SeqCst);
        // Frames fetched ahead make room only among media used before this task began, so the task
        // never removes what it fetched itself.
        let began = sync.now();
        for (path, bytes) in files {
            if stop() {
                return false;
            }
            let Some(dir) = self.controller.library().dir(meeting) else {
                return false;
            };
            // What Rukoo asks for now goes first, and may bring this file or fill the cache.
            while self.media.upgrade().is_some_and(|media| media.busy()) {
                if stop() {
                    return false;
                }
                thread::sleep(YIELD);
            }
            if dir.path().join(&path).is_file() {
                continue;
            }
            if matches!(task, Task::All(_)) && !sync.kept().iter().any(|id| id == meeting) {
                return false;
            }
            if !sync.can_fetch() {
                return true;
            }
            // Nobody asked for these frames yet: they come only while they fit within the limit
            // (a kept meeting's media doesn't count against it). The room stays reserved until
            // the frame is here, so what Rukoo fetches meanwhile trims to leave it.
            let limit = self.limit.load(Ordering::SeqCst);
            let ahead = matches!(task, Task::Frames(_)) && limit > 0;
            let reserved = ahead.then(|| Reserved::new(&self.reserved, bytes));
            if ahead && !sync.cache_room(limit, bytes, began, &|m, p| self.in_use(m, p)) {
                log::info!("media: fetching {meeting}'s frames ahead stopped at the cache limit");
                return false;
            }
            let fetched = sync.ensure_local(meeting, std::slice::from_ref(&path), cancel);
            drop(reserved);
            if let Err(e) = fetched {
                if stop() {
                    return false;
                }
                log::info!("media: fetching {meeting} in the background stopped: {e}");
                return true;
            }
            // Something read now may have kept the cache from making all the room: once the frame
            // is here, the limit removes what was used before the task began, never what it
            // fetched, and fetching ahead stops while the cache is over.
            if ahead && !sync.cache_room(limit, 0, began, &|m, p| self.in_use(m, p)) {
                log::info!("media: fetching {meeting}'s frames ahead stopped at the cache limit");
                return false;
            }
        }
        false
    }
}

/// Bytes reserved in [`MediaCache::reserved`] while it lives.
struct Reserved<'a> {
    total: &'a AtomicU64,
    bytes: u64,
}

impl<'a> Reserved<'a> {
    fn new(total: &'a AtomicU64, bytes: u64) -> Reserved<'a> {
        total.fetch_add(bytes, Ordering::SeqCst);
        Reserved { total, bytes }
    }
}

impl Drop for Reserved<'_> {
    fn drop(&mut self) {
        self.total.fetch_sub(self.bytes, Ordering::SeqCst);
    }
}

/// The `media-behind` thread: runs queued tasks until none is left.
fn run_loop(cache: Weak<MediaCache>) {
    crate::platform::background_thread();
    loop {
        let Some(this) = cache.upgrade() else {
            return;
        };
        let (task, cancel) = {
            let mut inner = this.lock();
            let Some(task) = inner.queue.pop_front() else {
                inner.running = false;
                return;
            };
            let cancel = Arc::new(AtomicBool::new(false));
            inner.current = Some((task.meeting().to_owned(), Arc::clone(&cancel)));
            (task, cancel)
        };
        let stalled =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| this.run(&task, &cancel)))
                .unwrap_or_else(|_| {
                    log::error!("media: a background fetch panicked");
                    true
                });
        let mut inner = this.lock();
        inner.current = None;
        if let Task::All(meeting) = &task {
            if stalled {
                inner.stalled.insert(meeting.clone(), Instant::now());
            } else {
                inner.stalled.remove(meeting);
            }
        }
        this.idle.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meetings::controller::{ControllerOptions, ControllerTiming};

    /// A deletion refused because a background fetch of the meeting doesn't stop in time leaves
    /// the meeting as it was: a later prefetch or keep of it is queued again.
    #[test]
    fn a_refused_deletion_lets_later_fetches_of_the_meeting_through() {
        let data = std::env::temp_dir().join(format!("voice-cache-forget-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let controller = Controller::new(
            ControllerOptions {
                data_dir: data.clone(),
                recorder_exe: data.join("no-recorder"),
                sources: Vec::new(),
                timing: ControllerTiming::default(),
            },
            |_| {},
        )
        .unwrap();
        let cache = MediaCache::new(None, controller, Weak::new());
        let meeting = "m-20261030-171203-4f2a";
        // A fetch for the meeting runs and never notices its cancel flag.
        let cancel = Arc::new(AtomicBool::new(false));
        cache.lock().current = Some((meeting.to_owned(), Arc::clone(&cancel)));
        let refused = cache.forget_within(meeting, Duration::from_millis(50));
        assert_eq!(refused.unwrap_err().code, voice_protocol::ErrorCode::Busy);
        assert!(cancel.load(Ordering::SeqCst), "the fetch was asked to stop");
        assert!(!cache.lock().forgotten.contains(meeting));
        // Queued as before; the thread isn't started while `running` says one runs.
        cache.lock().running = true;
        cache.push(Task::All(meeting.to_owned()));
        assert_eq!(
            cache.lock().queue,
            VecDeque::from([Task::All(meeting.to_owned())])
        );
        let _ = fs::remove_dir_all(&data);
    }
}
