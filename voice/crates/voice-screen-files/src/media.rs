//! The bridge's answers to `frame.get` and `clip.get`, and the clip files bucket sync and media
//! links share. Platform-neutral: these read the screen folder and cut clips without encoding.
//!
//! Clips are `screen/clips/c-<start 9>-<end 9>-<seq 6>.mp4`, written as `.mp4.tmp`, synced and
//! renamed under a process-wide lock per clip path, and deleted an hour after their last use.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde_json::{json, Value};

use crate::frames::FrameIndex;
use crate::journal::{self, Line};
use crate::{mp4, paths};

/// Why a frame or clip can't be had. The bridge maps these to the error codes of the same name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaError {
    NotFound(String),
    NotAvailable(String),
    Failed(String),
}

impl std::fmt::Display for MediaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MediaError::NotFound(m) | MediaError::NotAvailable(m) | MediaError::Failed(m) => {
                f.write_str(m)
            }
        }
    }
}

impl std::error::Error for MediaError {}

/// The largest frame image `frame.get` returns; `IMAGE_MAX` in `src/main/agents/tools.js`.
pub const MAX_FRAME_BYTES: u64 = 5 << 20;
/// The most video one clip request cuts; `voice_protocol::MAX_CLIP_MS`.
pub const MAX_CLIP_MS: u64 = 300_000;

const NO_SCREEN: &str = "The meeting didn't record the screen.";
const NO_VIDEO: &str = "The meeting didn't record video.";
const NO_FRAME: &str = "No frame at or before that time.";
const FRAME_REMOVED: &str = "The meeting's screen media was removed.";
const NO_CLIP: &str = "No video between those times.";
const VIDEO_REMOVED: &str = "The meeting's video was removed.";

/// `frame.get`: `{ frame: { id, at, width, height, text }, image: { type: "image/jpeg", data } }`
/// for the frame at or before `at`, with the image in standard base64.
pub fn frame_reply(
    meeting: &Path,
    recorded_screen: bool,
    at: u64,
    index: &FrameIndex,
) -> Result<Value, MediaError> {
    if !recorded_screen {
        return Err(MediaError::NotAvailable(NO_SCREEN.into()));
    }
    let frame = index
        .at_or_before(at)
        .ok_or_else(|| MediaError::NotFound(NO_FRAME.into()))?;
    let path = paths::frame_path(meeting, &frame.file).ok_or_else(|| {
        MediaError::Failed("The screen journal names a file that isn't a frame.".into())
    })?;
    let image = match File::open(&path) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(MAX_FRAME_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| MediaError::Failed(format!("Can't read the frame's image: {e}")))?;
            bytes
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err(MediaError::NotAvailable(FRAME_REMOVED.into()))
        }
        Err(e) => {
            return Err(MediaError::Failed(format!(
                "Can't read the frame's image: {e}"
            )))
        }
    };
    if image.len() as u64 > MAX_FRAME_BYTES {
        return Err(MediaError::Failed(
            "The frame's image is larger than 5 MiB.".into(),
        ));
    }
    Ok(json!({
        "frame": {
            "id": frame.id,
            "at": frame.t,
            "width": frame.width,
            "height": frame.height,
            "text": frame.text,
        },
        "image": {
            "type": "image/jpeg",
            "data": base64::engine::general_purpose::STANDARD.encode(&image),
        },
    }))
}

/// Whether a cut may go on, from the bytes of video it reads, an upper bound on the clips it
/// writes. `Err` is the request's answer. It runs on the cut's thread after the plan, so a slow
/// check doesn't hold the answer past its deadline either.
pub type ClipCheck = Box<dyn FnOnce(u64) -> Result<(), MediaError> + Send>;

/// `clip.get`: `{ clips: [{ path, start, end, width, height, bytes }] }` with the clips finished
/// by `wait_until`; `clips: []` when none was finished yet. Reading the journal, indexing the
/// video files and `check` happen on the cut's thread, which a later request joins, so this
/// answers by `wait_until` however long a meeting and however slow its disk.
pub fn clip_reply(
    meeting: &Path,
    recorded_video: bool,
    start: u64,
    end: u64,
    wait_until: Instant,
    check: Option<ClipCheck>,
) -> Result<Value, MediaError> {
    if !recorded_video {
        return Err(MediaError::NotAvailable(NO_VIDEO.into()));
    }
    let cut = cut_clips_within(meeting, start, end, wait_until, CLIP_BUDGET, check)?;
    let clips: Vec<Value> = cut
        .clips
        .iter()
        .map(|c| {
            json!({
                "path": c.path.to_string_lossy(),
                "start": c.start,
                "end": c.end,
                "width": c.width,
                "height": c.height,
                "bytes": c.bytes,
            })
        })
        .collect();
    Ok(json!({ "clips": clips }))
}

/// Deletes clips under every meeting whose modification time is over `max_age_ms` old, and
/// leftover `.mp4.tmp` files as old. A clip that is being cut or reused right now is skipped.
/// Returns how many it deleted.
pub fn sweep_clips(meetings_root: &Path, now_wall_ms: u64, max_age_ms: u64) -> usize {
    let Ok(meetings) = std::fs::read_dir(meetings_root) else {
        return 0;
    };
    let mut deleted = 0;
    for meeting in meetings.flatten() {
        let Ok(clips) = std::fs::read_dir(paths::clips_dir(&meeting.path())) else {
            continue;
        };
        for clip in clips.flatten() {
            let path = clip.path();
            let name = clip.file_name().to_string_lossy().into_owned();
            let target = match name.strip_suffix(".tmp") {
                Some(base) => path.with_file_name(base),
                None => path.clone(),
            };
            if !name.starts_with("c-") || target.extension().is_none_or(|e| e != "mp4") {
                continue;
            }
            let Some(_guard) = try_lock_path(&target) else {
                continue;
            };
            let Some(modified) = clip.metadata().ok().and_then(|m| m.modified().ok()) else {
                continue;
            };
            if now_wall_ms.saturating_sub(wall_ms(modified)) > max_age_ms
                && std::fs::remove_file(&path).is_ok()
            {
                deleted += 1;
            }
        }
    }
    deleted
}

fn wall_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

/// A cut clip. `start` and `end` are meeting ms of what it holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClipFile {
    pub path: PathBuf,
    pub start: u64,
    pub end: u64,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClipCut {
    pub clips: Vec<ClipFile>,
    /// Every stretch of the range is cut.
    pub complete: bool,
}

/// How long a background cut may run, its plan included.
pub const CLIP_BUDGET: Duration = Duration::from_secs(120);

/// One file per stretch of continuous video in `[start, min(end, start + MAX_CLIP_MS)]`, oldest
/// first; a reused clip gets its modification time set to now. A background thread per
/// (meeting, start, end) plans the cut from the journal and the video files, then cuts each clip
/// to `.mp4.tmp`, syncs and renames it under a per-path lock; this call returns at completion or
/// `wait_until`.
pub fn cut_clips(
    meeting: &Path,
    start: u64,
    end: u64,
    wait_until: Instant,
) -> Result<ClipCut, MediaError> {
    cut_clips_within(meeting, start, end, wait_until, CLIP_BUDGET, None)
}

/// `[start, end]` with `end` at least `start` and at most `MAX_CLIP_MS` after it.
fn capped(start: u64, end: u64) -> (u64, u64) {
    (start, end.max(start).min(start.saturating_add(MAX_CLIP_MS)))
}

/// Joins the cut of the range that runs, or starts one with `check`. Only a map lookup happens
/// before the wait, and the map's lock is let go before it: every request for any meeting goes
/// through that lock, so a caller waiting on a slow cut while holding it would keep others past
/// their own deadlines.
fn cut_clips_within(
    meeting: &Path,
    start: u64,
    end: u64,
    wait_until: Instant,
    budget: Duration,
    check: Option<ClipCheck>,
) -> Result<ClipCut, MediaError> {
    let (start, end) = capped(start, end);
    let key = (meeting.to_path_buf(), start, end);
    let (job, new) = {
        let mut running = lock(jobs());
        match running.get(&key) {
            Some(job) => (job.clone(), false),
            None => {
                let job = Arc::new(Job::default());
                running.insert(key.clone(), job.clone());
                (job, true)
            }
        }
    };
    if new {
        let worker = job.clone();
        let spawned = std::thread::Builder::new()
            .name("clip-cut".into())
            .spawn(move || run_job(&worker, key, check, budget));
        if let Err(e) = spawned {
            lock(jobs()).remove(&(meeting.to_path_buf(), start, end));
            return Err(MediaError::Failed(format!("Can't start the cut: {e}")));
        }
    }
    job.wait(wait_until)
}

/// Bytes the fragments of `[start, end]` take, an upper bound on the clip's size, for
/// `policy::reserve_ok`.
pub fn clip_input_bytes(meeting: &Path, start: u64, end: u64) -> io::Result<u64> {
    let (start, end) = capped(start, end);
    let mut bytes = 0;
    for stretch in overlapping(&journal::read_all(meeting)?, start, end) {
        let Some(path) = paths::video_path(meeting, &stretch.file) else {
            continue;
        };
        let index = match mp4::index_path(&path) {
            Ok(index) => index,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        let (from, to) = stretch.media_range(start, end);
        if let Some(cut) = mp4::plan(&index, from, to) {
            bytes += cut.bytes;
        }
    }
    Ok(bytes)
}

/// The video files, as relative paths, that a clip of `[start, end]` reads.
pub fn video_inputs(meeting: &Path, start: u64, end: u64) -> io::Result<Vec<String>> {
    let (start, end) = capped(start, end);
    Ok(overlapping(&journal::read_all(meeting)?, start, end)
        .into_iter()
        .filter(|s| paths::video_path(meeting, &s.file).is_some())
        .map(|s| s.file)
        .collect())
}

/// (frames, video) from `meeting.json`'s `screen`: `off` (false, false), `frames` (true, false),
/// `video` (true, true).
pub fn recorded(meeting: &Path) -> (bool, bool) {
    let screen = std::fs::read(meeting.join("meeting.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|m| m["screen"].as_str().map(str::to_string));
    match screen.as_deref() {
        Some("frames") => (true, false),
        Some("video") => (true, true),
        _ => (false, false),
    }
}

/// The kind of a closed screen file, for bucket sync.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ScreenFileKind {
    Journal,
    Frame,
    Video,
}

/// Every closed screen file that may sync, as relative paths: a frame once journaled, a video
/// file after its `video_end`, the journal after `stop`; never `clips/`, `screen.json` or
/// `*.tmp`. Files no longer on disk are left out. Frames and videos come in journal order, the
/// journal last.
pub fn closed_files(meeting: &Path) -> io::Result<Vec<(String, ScreenFileKind)>> {
    let lines = journal::read_all(meeting)?;
    let ended: HashSet<u64> = lines
        .iter()
        .filter_map(|l| match l {
            Line::VideoEnd { seq, .. } => Some(*seq),
            _ => None,
        })
        .collect();
    let frames_dir = format!("{}/{}/", paths::SCREEN_DIR, paths::FRAMES_DIR);
    let video_dir = format!("{}/{}/", paths::SCREEN_DIR, paths::VIDEO_DIR);
    let on_disk = |file: &str| paths::resolve(meeting, file).is_some_and(|p| p.is_file());
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut stopped = false;
    for line in &lines {
        let (file, kind) = match line {
            Line::Frame { file, .. } if file.starts_with(&frames_dir) && file.ends_with(".jpg") => {
                (file, ScreenFileKind::Frame)
            }
            Line::Video { seq, file, .. }
                if ended.contains(seq)
                    && file.starts_with(&video_dir)
                    && file.ends_with(".mp4") =>
            {
                (file, ScreenFileKind::Video)
            }
            Line::Stop { .. } => {
                stopped = true;
                continue;
            }
            _ => continue,
        };
        if on_disk(file) && seen.insert(file.clone()) {
            out.push((file.clone(), kind));
        }
    }
    if stopped {
        out.push((
            format!("{}/{}", paths::SCREEN_DIR, paths::JOURNAL_FILE),
            ScreenFileKind::Journal,
        ));
    }
    Ok(out)
}

/// Sets a clip's modification time to now, under its lock, so the sweep keeps it another hour.
/// For bucket sync's media links, which serve clips `cut_clips` made.
pub fn touch_clip(path: &Path) -> io::Result<()> {
    let _guard = lock_path(path);
    touch(path)
}

fn touch(path: &Path) -> io::Result<()> {
    File::options()
        .write(true)
        .open(path)?
        .set_modified(SystemTime::now())
}

/// A stretch of continuous video: one video file of the journal.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Stretch {
    seq: u64,
    file: String,
    t: u64,
    /// The `t` of its `video_end`, or `None` while it records.
    end: Option<u64>,
    width: u32,
    height: u32,
}

impl Stretch {
    /// `[start, end]` in ms of this file's media time.
    fn media_range(&self, start: u64, end: u64) -> (u64, u64) {
        (start.saturating_sub(self.t), end.saturating_sub(self.t))
    }
}

/// The video files whose time overlaps `[start, end]`, in journal order.
fn overlapping(lines: &[Line], start: u64, end: u64) -> Vec<Stretch> {
    let mut stretches: Vec<Stretch> = Vec::new();
    for line in lines {
        match line {
            Line::Video {
                t,
                seq,
                file,
                width,
                height,
                ..
            } => stretches.push(Stretch {
                seq: *seq,
                file: file.clone(),
                t: *t,
                end: None,
                width: *width,
                height: *height,
            }),
            Line::VideoEnd { t, seq, .. } => {
                if let Some(s) = stretches.iter_mut().rev().find(|s| s.seq == *seq) {
                    s.end = Some(*t);
                }
            }
            _ => {}
        }
    }
    stretches
        .into_iter()
        .filter(|s| s.t <= end && s.end.is_none_or(|e| e >= start))
        .collect()
}

/// One clip to make.
#[derive(Clone, Debug)]
struct Planned {
    stretch: Stretch,
    src: PathBuf,
    dst: PathBuf,
    from_ms: u64,
    to_ms: u64,
    /// What the cut holds and how many fragments, as the source looks now.
    cut: mp4::Cut,
    fragments: usize,
}

impl Planned {
    fn clip(&self, cut: &mp4::Cut, bytes: u64) -> ClipFile {
        ClipFile {
            path: self.dst.clone(),
            start: self.stretch.t + cut.start_ms,
            end: self.stretch.t + cut.end_ms,
            width: self.stretch.width,
            height: self.stretch.height,
            bytes,
        }
    }
}

/// The clips a request makes, from the journal and the video files as they are now. A long
/// meeting on a slow disk makes this slow, so only a cut's thread calls it.
fn plan_clips(meeting: &Path, start: u64, end: u64) -> Result<Vec<Planned>, MediaError> {
    #[cfg(test)]
    tests::slow_plan(meeting);
    let lines = journal::read_all(meeting)
        .map_err(|e| MediaError::Failed(format!("Can't read the screen journal: {e}")))?;
    let stretches = overlapping(&lines, start, end);
    let mut missing = 0;
    let mut planned = Vec::new();
    for stretch in &stretches {
        let Some(src) = paths::video_path(meeting, &stretch.file) else {
            continue;
        };
        let index = match mp4::index_path(&src) {
            Ok(index) => index,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                missing += 1;
                continue;
            }
            Err(e) => return Err(MediaError::Failed(format!("Can't read the video: {e}"))),
        };
        let (from_ms, to_ms) = stretch.media_range(start, end);
        let Some(range) = mp4::select(&index, from_ms, to_ms) else {
            continue;
        };
        let Some(cut) = mp4::plan(&index, from_ms, to_ms) else {
            continue;
        };
        planned.push(Planned {
            stretch: stretch.clone(),
            dst: paths::clip_path(meeting, start, end, stretch.seq),
            src,
            from_ms,
            to_ms,
            cut,
            fragments: range.len(),
        });
    }
    if planned.is_empty() {
        return Err(if missing > 0 && missing == stretches.len() {
            MediaError::NotAvailable(VIDEO_REMOVED.into())
        } else {
            MediaError::NotFound(NO_CLIP.into())
        });
    }
    Ok(planned)
}

/// A cut in progress, shared by every caller asking for the same range.
#[derive(Default)]
struct Job {
    state: Mutex<JobState>,
    changed: Condvar,
}

#[derive(Default)]
struct JobState {
    clips: Vec<ClipFile>,
    done: bool,
    complete: bool,
    error: Option<MediaError>,
}

impl Job {
    /// The clips finished when the job is done or at `until`, whichever comes first.
    fn wait(&self, until: Instant) -> Result<ClipCut, MediaError> {
        let mut state = lock(&self.state);
        while !state.done {
            let now = Instant::now();
            if now >= until {
                break;
            }
            state = self
                .changed
                .wait_timeout(state, until - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        if state.done && state.clips.is_empty() {
            if let Some(error) = &state.error {
                return Err(error.clone());
            }
        }
        Ok(ClipCut {
            clips: state.clips.clone(),
            complete: state.done && state.complete,
        })
    }

    fn add(&self, clip: ClipFile) {
        lock(&self.state).clips.push(clip);
        self.changed.notify_all();
    }
}

type JobKey = (PathBuf, u64, u64);

fn jobs() -> &'static Mutex<HashMap<JobKey, Arc<Job>>> {
    static JOBS: OnceLock<Mutex<HashMap<JobKey, Arc<Job>>>> = OnceLock::new();
    JOBS.get_or_init(Mutex::default)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Plans the cut, asks `check`, then cuts each planned clip in turn, reusing one that is there
/// already, until the budget runs out.
fn run_job(job: &Arc<Job>, key: JobKey, check: Option<ClipCheck>, budget: Duration) {
    let deadline = Instant::now() + budget;
    let (meeting, start, end) = (&key.0, key.1, key.2);
    let planned = plan_clips(meeting, start, end).and_then(|planned| {
        if let Some(check) = check {
            check(planned.iter().map(|p| p.cut.bytes).sum())?;
        }
        Ok(planned)
    });
    let (complete, error) = match planned {
        Ok(planned) => cut_planned(job, &planned, deadline),
        Err(e) => (false, Some(e)),
    };
    {
        let mut state = lock(&job.state);
        state.done = true;
        state.complete = complete;
        state.error = error;
    }
    job.changed.notify_all();
    let mut jobs = lock(jobs());
    if jobs.get(&key).is_some_and(|j| Arc::ptr_eq(j, job)) {
        jobs.remove(&key);
    }
}

/// Cuts the planned clips until `deadline`. Returns whether every one is there, and the error
/// of the last one that failed.
fn cut_planned(job: &Job, planned: &[Planned], deadline: Instant) -> (bool, Option<MediaError>) {
    let mut complete = true;
    let mut error = None;
    for plan in planned {
        let _guard = lock_path(&plan.dst);
        if let Some(clip) = reuse(plan) {
            job.add(clip);
            continue;
        }
        let mut tmp = plan.dst.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        let _ = std::fs::remove_file(&tmp);
        if let Some(dir) = plan.dst.parent() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                complete = false;
                error = Some(MediaError::Failed(format!("Can't write the clip: {e}")));
                break;
            }
        }
        match mp4::cut_until(&plan.src, plan.from_ms, plan.to_ms, &tmp, Some(deadline)) {
            Ok(Some(cut)) => match std::fs::rename(&tmp, &plan.dst) {
                Ok(()) => job.add(plan.clip(&cut, cut.bytes)),
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp);
                    complete = false;
                    error = Some(MediaError::Failed(format!("Can't write the clip: {e}")));
                }
            },
            // The file lost the fragments since the plan, as a repair can do: nothing to cut.
            Ok(None) => {}
            Err(e) if e.kind() == io::ErrorKind::TimedOut => {
                complete = false;
                break;
            }
            Err(e) => {
                complete = false;
                error = Some(MediaError::Failed(format!("Can't cut the clip: {e}")));
            }
        }
    }
    (complete, error)
}

/// The clip at the plan's path, when it is there and holds every fragment the plan does. A clip
/// cut while its video was still growing can hold fewer; it is cut again.
fn reuse(plan: &Planned) -> Option<ClipFile> {
    let index = mp4::index_path(&plan.dst).ok()?;
    if index.fragments.len() != plan.fragments || index.complete_len != index.file_len {
        return None;
    }
    touch(&plan.dst).ok()?;
    Some(plan.clip(&plan.cut, index.file_len))
}

/// Clip paths being written or reused, process-wide.
struct PathLocks {
    held: Mutex<HashSet<PathBuf>>,
    freed: Condvar,
}

fn path_locks() -> &'static PathLocks {
    static LOCKS: OnceLock<PathLocks> = OnceLock::new();
    LOCKS.get_or_init(|| PathLocks {
        held: Mutex::new(HashSet::new()),
        freed: Condvar::new(),
    })
}

/// Holds a clip path until dropped.
struct PathGuard {
    path: PathBuf,
}

impl Drop for PathGuard {
    fn drop(&mut self) {
        let locks = path_locks();
        lock(&locks.held).remove(&self.path);
        locks.freed.notify_all();
    }
}

/// Waits until no one else holds `path`, then holds it.
fn lock_path(path: &Path) -> PathGuard {
    let locks = path_locks();
    let mut held = lock(&locks.held);
    while held.contains(path) {
        held = locks.freed.wait(held).unwrap_or_else(|e| e.into_inner());
    }
    held.insert(path.to_path_buf());
    PathGuard {
        path: path.to_path_buf(),
    }
}

/// Holds `path` when no one else does.
fn try_lock_path(path: &Path) -> Option<PathGuard> {
    let mut held = lock(&path_locks().held);
    held.insert(path.to_path_buf()).then(|| PathGuard {
        path: path.to_path_buf(),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Barrier;

    use super::*;
    use crate::journal::JournalWriter;
    use crate::mp4::synth;
    use crate::testdir::TestDir;

    const TS: u32 = 30_000;

    /// A meeting folder with `meeting.json` saying `screen`.
    fn meeting(name: &str, screen: &str) -> TestDir {
        let dir = TestDir::new(name);
        std::fs::write(
            dir.path().join("meeting.json"),
            json!({ "id": "m-20261030-171203-4f2a", "screen": screen, "version": 1 }).to_string(),
        )
        .unwrap();
        dir
    }

    /// A video file of `seconds` 1 s fragments, each starting on a keyframe.
    fn write_video(meeting: &Path, seq: u64, seconds: usize) -> u64 {
        let fragments: Vec<_> = (0..seconds)
            .map(|_| synth::samples(15, 2_000, 200, true))
            .collect();
        let bytes = synth::file(TS, &fragments);
        let path = paths::resolve(meeting, &paths::video_file(seq)).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        bytes.len() as u64
    }

    fn video(t: u64, seq: u64) -> Line {
        Line::Video {
            t,
            seq,
            file: paths::video_file(seq),
            width: 1920,
            height: 1080,
            fps: 15,
            encoder: "Microsoft H.264 Encoder MFT".into(),
            hardware: false,
        }
    }

    fn video_end(t: u64, seq: u64) -> Line {
        Line::VideoEnd {
            t,
            seq,
            reason: "pause".into(),
            bytes: 0,
        }
    }

    fn frame(t: u64, text: &str) -> Line {
        let id = paths::frame_id(t);
        Line::Frame {
            t,
            file: paths::frame_file(&id),
            id,
            width: 1920,
            height: 1080,
            text: text.into(),
            ocr: "ok".into(),
            language: Some("nl-NL".into()),
        }
    }

    fn journal(meeting: &Path, lines: &[Line]) {
        let mut w = JournalWriter::open(meeting).unwrap();
        for line in lines {
            w.write(line).unwrap();
        }
    }

    fn write_frame(meeting: &Path, t: u64, bytes: &[u8]) {
        let path = paths::resolve(meeting, &paths::frame_file(&paths::frame_id(t))).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    /// Two stretches: video 1 from 1 s to 7 s (ended at a pause), video 2 from 9 s, still open.
    fn two_stretches(name: &str) -> TestDir {
        let m = meeting(name, "video");
        write_video(m.path(), 1, 6);
        write_video(m.path(), 2, 6);
        journal(
            m.path(),
            &[video(1_000, 1), video_end(7_000, 1), video(9_000, 2)],
        );
        m
    }

    fn clip_files(meeting: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(paths::clips_dir(meeting))
            .map(|d| {
                d.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn soon() -> Instant {
        Instant::now() + Duration::from_secs(20)
    }

    /// Meetings whose plan takes this long, standing in for a long recording on a slow disk.
    fn slow_plans() -> MutexGuard<'static, HashMap<PathBuf, Duration>> {
        static SLOW: OnceLock<Mutex<HashMap<PathBuf, Duration>>> = OnceLock::new();
        lock(SLOW.get_or_init(Mutex::default))
    }

    /// Called by `plan_clips`: sleeps for a meeting a test made slow.
    pub(super) fn slow_plan(meeting: &Path) {
        let wait = slow_plans().get(meeting).copied();
        if let Some(wait) = wait {
            std::thread::sleep(wait);
        }
    }

    #[test]
    fn a_slow_plan_or_check_doesn_t_hold_the_answer() {
        let m = two_stretches("clip-slow-plan");
        slow_plans().insert(m.path().to_path_buf(), Duration::from_millis(1_500));
        let asked = Instant::now();
        let reply = clip_reply(
            m.path(),
            true,
            2_000,
            12_000,
            asked + Duration::from_millis(300),
            None,
        )
        .unwrap();
        let took = asked.elapsed();
        assert!(
            took < Duration::from_millis(1_000),
            "answered after {took:?}"
        );
        assert_eq!(reply, json!({ "clips": [] }));
        // The plan and the cut go on; the same request later returns both files.
        let reply = clip_reply(m.path(), true, 2_000, 12_000, soon(), None).unwrap();
        assert_eq!(reply["clips"].as_array().unwrap().len(), 2, "{reply}");
        slow_plans().remove(m.path());

        // The check runs on the cut's thread with the bytes the cut reads: a slow one doesn't
        // hold the answer, and its refusal is the answer when it comes in time.
        let input = clip_input_bytes(m.path(), 5_000, 10_000).unwrap();
        assert!(input > 0);
        let (seen, bytes) = std::sync::mpsc::channel();
        let slow: ClipCheck = Box::new(move |b| {
            std::thread::sleep(Duration::from_millis(1_500));
            seen.send(b).unwrap();
            Err(MediaError::Failed(
                "Not enough free disk space to cut a clip.".into(),
            ))
        });
        let asked = Instant::now();
        let reply = clip_reply(
            m.path(),
            true,
            5_000,
            10_000,
            asked + Duration::from_millis(300),
            Some(slow),
        )
        .unwrap();
        let took = asked.elapsed();
        assert!(
            took < Duration::from_millis(1_000),
            "answered after {took:?}"
        );
        assert_eq!(reply, json!({ "clips": [] }));
        assert_eq!(bytes.recv_timeout(Duration::from_secs(10)), Ok(input));
        let refuse: ClipCheck = Box::new(|_| {
            Err(MediaError::Failed(
                "Not enough free disk space to cut a clip.".into(),
            ))
        });
        assert_eq!(
            clip_reply(m.path(), true, 5_000, 10_000, soon(), Some(refuse)),
            Err(MediaError::Failed(
                "Not enough free disk space to cut a clip.".into()
            ))
        );
        assert!(
            !clip_files(m.path())
                .iter()
                .any(|n| n.starts_with("c-000005000")),
            "a refused cut writes nothing"
        );
    }

    /// A caller that joins a slow cut and waits with a long deadline doesn't keep other requests,
    /// for another meeting with a shorter deadline, past theirs.
    #[test]
    fn a_caller_waiting_on_a_slow_cut_doesn_t_hold_other_requests() {
        let slow = two_stretches("clip-joined-slow");
        let other = two_stretches("clip-joined-other");
        slow_plans().insert(slow.path().to_path_buf(), Duration::from_millis(2_500));
        // Starts the slow cut and goes, then a second caller joins it with a long deadline.
        let first = cut_clips(slow.path(), 2_000, 12_000, Instant::now()).unwrap();
        assert_eq!(first.clips, Vec::new());
        let joined_path = slow.path().to_path_buf();
        let joiner = std::thread::spawn(move || {
            cut_clips(
                &joined_path,
                2_000,
                12_000,
                Instant::now() + Duration::from_secs(5),
            )
        });
        std::thread::sleep(Duration::from_millis(200));
        let asked = Instant::now();
        cut_clips(
            other.path(),
            2_000,
            12_000,
            asked + Duration::from_millis(300),
        )
        .unwrap();
        let took = asked.elapsed();
        assert!(
            took < Duration::from_millis(1_000),
            "a request for another meeting answered after {took:?}"
        );
        let joined = joiner.join().unwrap().unwrap();
        assert_eq!(joined.clips.len(), 2, "{joined:?}");
        slow_plans().remove(slow.path());
    }

    #[test]
    fn limits_match_the_protocol_and_rukoo() {
        assert_eq!(MAX_CLIP_MS, voice_protocol::MAX_CLIP_MS);
        assert_eq!(MAX_FRAME_BYTES, 5 * 1024 * 1024);
    }

    #[test]
    fn recorded_reads_the_meeting_s_screen_mode() {
        assert_eq!(recorded(meeting("rec-off", "off").path()), (false, false));
        assert_eq!(
            recorded(meeting("rec-frames", "frames").path()),
            (true, false)
        );
        assert_eq!(recorded(meeting("rec-video", "video").path()), (true, true));
        assert_eq!(
            recorded(meeting("rec-new", "hologram").path()),
            (false, false)
        );
        assert_eq!(recorded(TestDir::new("rec-none").path()), (false, false));
    }

    #[test]
    fn frame_reply_answers_at_or_before() {
        let m = meeting("frame-reply", "frames");
        journal(
            m.path(),
            &[frame(1_000, "Slide 1"), frame(12_000, "Slide 2\nQ3")],
        );
        write_frame(m.path(), 1_000, b"\xff\xd8one\xff\xd9");
        write_frame(m.path(), 12_000, b"\xff\xd8two\xff\xd9");
        let index = FrameIndex::load(m.path()).unwrap();

        let reply = frame_reply(m.path(), true, 12_000, &index).unwrap();
        assert_eq!(
            reply,
            json!({
                "frame": { "id": "f-000012000", "at": 12_000, "width": 1920, "height": 1080, "text": "Slide 2\nQ3" },
                "image": { "type": "image/jpeg", "data": base64::engine::general_purpose::STANDARD.encode(b"\xff\xd8two\xff\xd9") },
            })
        );
        let before = frame_reply(m.path(), true, 11_999, &index).unwrap();
        assert_eq!(before["frame"]["id"], "f-000001000");
        assert_eq!(
            frame_reply(m.path(), true, u64::MAX, &index).unwrap()["frame"]["at"],
            12_000
        );
        assert_eq!(
            frame_reply(m.path(), true, 999, &index),
            Err(MediaError::NotFound(NO_FRAME.into()))
        );
        assert_eq!(
            frame_reply(m.path(), false, 12_000, &index),
            Err(MediaError::NotAvailable(NO_SCREEN.into()))
        );
    }

    #[test]
    fn frame_reply_refuses_removed_and_oversized_images() {
        let m = meeting("frame-reply-bad", "frames");
        journal(
            m.path(),
            &[frame(1_000, ""), frame(2_000, ""), frame(3_000, "")],
        );
        write_frame(m.path(), 2_000, &vec![0u8; MAX_FRAME_BYTES as usize + 1]);
        write_frame(m.path(), 3_000, &vec![0u8; MAX_FRAME_BYTES as usize]);
        let index = FrameIndex::load(m.path()).unwrap();
        assert_eq!(
            frame_reply(m.path(), true, 1_500, &index),
            Err(MediaError::NotAvailable(FRAME_REMOVED.into()))
        );
        assert!(matches!(
            frame_reply(m.path(), true, 2_000, &index),
            Err(MediaError::Failed(_))
        ));
        assert!(frame_reply(m.path(), true, 3_000, &index).is_ok());
        // A damaged journal can't make it read files outside the screen folder.
        let outside = FrameIndex::from_lines(&[Line::Frame {
            t: 5,
            id: "f-000000005".into(),
            file: "screen/../meeting.json".into(),
            width: 1,
            height: 1,
            text: String::new(),
            ocr: "none".into(),
            language: None,
        }]);
        assert!(matches!(
            frame_reply(m.path(), true, 5, &outside),
            Err(MediaError::Failed(_))
        ));
        // Nor read another file of the screen folder, such as screen.json with its token.
        std::fs::write(paths::screen_file_path(m.path()), br#"{"token":"secret"}"#).unwrap();
        let token = FrameIndex::from_lines(&[Line::Frame {
            t: 5,
            id: "f-000000005".into(),
            file: "screen/screen.json".into(),
            width: 1,
            height: 1,
            text: String::new(),
            ocr: "none".into(),
            language: None,
        }]);
        assert!(matches!(
            frame_reply(m.path(), true, 5, &token),
            Err(MediaError::Failed(_))
        ));
    }

    #[test]
    fn clip_reply_cuts_one_clip_per_stretch() {
        let m = two_stretches("clip-two");
        // 5 s to 10 s: the end of video 1 and the start of video 2.
        let reply = clip_reply(m.path(), true, 5_000, 10_000, soon(), None).unwrap();
        let clips = reply["clips"].as_array().unwrap();
        assert_eq!(clips.len(), 2, "{reply}");
        // Video 1's media 4 s to its end at 6 s; video 2's first second, which ends at 10 s.
        assert_eq!(
            (clips[0]["start"].as_u64(), clips[0]["end"].as_u64()),
            (Some(5_000), Some(7_000))
        );
        assert_eq!(
            (clips[1]["start"].as_u64(), clips[1]["end"].as_u64()),
            (Some(9_000), Some(10_000))
        );
        assert_eq!(clips[0]["width"], 1920);
        let first = PathBuf::from(clips[0]["path"].as_str().unwrap());
        assert_eq!(first, paths::clip_path(m.path(), 5_000, 10_000, 1));
        assert_eq!(
            clips[0]["bytes"].as_u64(),
            Some(std::fs::metadata(&first).unwrap().len())
        );
        assert_eq!(
            clip_files(m.path()),
            vec![
                "c-000005000-000010000-000001.mp4".to_string(),
                "c-000005000-000010000-000002.mp4".to_string()
            ]
        );
        // A range inside one stretch, and a pause between them.
        let reply = clip_reply(m.path(), true, 9_500, 9_500, soon(), None).unwrap();
        assert_eq!(reply["clips"].as_array().unwrap().len(), 1);
        assert_eq!(
            clip_reply(m.path(), true, 7_200, 8_800, soon(), None),
            Err(MediaError::NotFound(NO_CLIP.into()))
        );
        assert_eq!(
            clip_reply(m.path(), true, 20_000, 30_000, soon(), None),
            Err(MediaError::NotFound(NO_CLIP.into()))
        );
        assert_eq!(
            clip_reply(m.path(), false, 5_000, 10_000, soon(), None),
            Err(MediaError::NotAvailable(NO_VIDEO.into()))
        );
    }

    #[test]
    fn clip_reply_caps_the_range_at_five_minutes() {
        let m = meeting("clip-cap", "video");
        write_video(m.path(), 1, 400);
        journal(m.path(), &[video(0, 1)]);
        let reply = clip_reply(m.path(), true, 10_000, 900_000, soon(), None).unwrap();
        let clip = &reply["clips"][0];
        assert_eq!(clip["start"], 10_000);
        assert_eq!(clip["end"], 10_000 + MAX_CLIP_MS);
        assert_eq!(
            clip_files(m.path()),
            vec![paths::clip_name(10_000, 10_000 + MAX_CLIP_MS, 1)]
        );
        // The same range asked differently shares the file.
        let again = clip_reply(m.path(), true, 10_000, 310_000, soon(), None).unwrap();
        assert_eq!(again["clips"][0]["path"], clip["path"]);
        assert_eq!(clip_files(m.path()).len(), 1);
    }

    #[test]
    fn clips_finished_so_far_come_back_at_the_deadline() {
        let m = two_stretches("clip-wait");
        // Something else holds the first clip's path, as a cut for media links could.
        let first = paths::clip_path(m.path(), 2_000, 12_000, 1);
        let guard = lock_path(&first);
        let reply = clip_reply(
            m.path(),
            true,
            2_000,
            12_000,
            Instant::now() + Duration::from_millis(300),
            None,
        )
        .unwrap();
        assert_eq!(reply, json!({ "clips": [] }));
        drop(guard);
        // The cut goes on; the same request later returns both files.
        let reply = clip_reply(m.path(), true, 2_000, 12_000, soon(), None).unwrap();
        assert_eq!(reply["clips"].as_array().unwrap().len(), 2, "{reply}");
        let names = clip_files(m.path());
        assert_eq!(names.len(), 2, "{names:?}");
        assert!(names.iter().all(|n| n.ends_with(".mp4")));

        // The second clip held instead: the first is finished by the deadline and comes back
        // alone, and a caller joining the running cut gets it too, marked incomplete.
        let second = paths::clip_path(m.path(), 3_000, 11_000, 2);
        let guard = lock_path(&second);
        let reply = clip_reply(
            m.path(),
            true,
            3_000,
            11_000,
            Instant::now() + Duration::from_secs(2),
            None,
        )
        .unwrap();
        let clips = reply["clips"].as_array().unwrap();
        assert_eq!(clips.len(), 1, "{reply}");
        assert_eq!(
            PathBuf::from(clips[0]["path"].as_str().unwrap()),
            paths::clip_path(m.path(), 3_000, 11_000, 1)
        );
        let joined = cut_clips(
            m.path(),
            3_000,
            11_000,
            Instant::now() + Duration::from_millis(200),
        )
        .unwrap();
        assert_eq!((joined.clips.len(), joined.complete), (1, false));
        assert!(!second.exists());
        drop(guard);
        let done = cut_clips(m.path(), 3_000, 11_000, soon()).unwrap();
        assert_eq!((done.clips.len(), done.complete), (2, true));
        assert_eq!(done.clips[0], joined.clips[0]);
        assert!(second.exists());
    }

    #[test]
    fn a_reused_clip_gets_a_new_modification_time() {
        let m = two_stretches("clip-reuse");
        let cut = cut_clips(m.path(), 2_000, 3_000, soon()).unwrap();
        assert!(cut.complete);
        let path = cut.clips[0].path.clone();
        let old = SystemTime::now() - Duration::from_secs(7_200);
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let again = cut_clips(m.path(), 2_000, 3_000, soon()).unwrap();
        assert_eq!(again, cut);
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert!(modified > old + Duration::from_secs(3_600));
    }

    #[test]
    fn a_clip_of_a_growing_file_is_cut_again_once_it_grew() {
        let m = meeting("clip-grow", "video");
        journal(m.path(), &[video(0, 1)]);
        // Three seconds on disk at first, the request reaching past them.
        let fragments: Vec<_> = (0..6)
            .map(|_| synth::samples(15, 2_000, 200, true))
            .collect();
        let bytes = synth::file(TS, &fragments);
        let src = paths::resolve(m.path(), &paths::video_file(1)).unwrap();
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        let three = synth::file(TS, &fragments[..3]).len();
        std::fs::write(&src, &bytes[..three]).unwrap();
        let early = cut_clips(m.path(), 1_000, 5_000, soon()).unwrap();
        assert_eq!(early.clips[0].end, 3_000);
        std::fs::write(&src, &bytes).unwrap();
        let later = cut_clips(m.path(), 1_000, 5_000, soon()).unwrap();
        assert_eq!(later.clips[0].end, 5_000);
        assert_eq!(later.clips[0].path, early.clips[0].path);
        assert_eq!(
            mp4::index_path(&later.clips[0].path)
                .unwrap()
                .fragments
                .len(),
            4
        );
    }

    #[test]
    fn two_threads_cutting_the_same_range_get_one_file() {
        let m = two_stretches("clip-threads");
        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let (dir, barrier) = (m.path().to_path_buf(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    cut_clips(&dir, 3_000, 9_500, soon()).unwrap()
                })
            })
            .collect();
        let cuts: Vec<ClipCut> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(cuts[0], cuts[1]);
        assert!(cuts[0].complete);
        assert_eq!(cuts[0].clips.len(), 2);
        assert_eq!(
            clip_files(m.path()),
            vec![
                paths::clip_name(3_000, 9_500, 1),
                paths::clip_name(3_000, 9_500, 2)
            ]
        );
    }

    #[test]
    fn a_cut_stopped_by_its_budget_leaves_no_file() {
        let m = two_stretches("clip-budget");
        let cut = cut_clips_within(m.path(), 2_000, 12_000, soon(), Duration::ZERO, None).unwrap();
        assert_eq!(
            cut,
            ClipCut {
                clips: vec![],
                complete: false
            }
        );
        assert_eq!(clip_files(m.path()), Vec::<String>::new());
        // The next request starts again and finishes.
        assert!(cut_clips(m.path(), 2_000, 12_000, soon()).unwrap().complete);
    }

    #[test]
    fn removed_video_is_not_available() {
        let m = two_stretches("clip-removed");
        for dir in paths::media_dirs(m.path()) {
            let _ = std::fs::remove_dir_all(dir);
        }
        assert_eq!(
            clip_reply(m.path(), true, 2_000, 12_000, soon(), None),
            Err(MediaError::NotAvailable(VIDEO_REMOVED.into()))
        );
        assert_eq!(clip_input_bytes(m.path(), 2_000, 12_000).unwrap(), 0);
    }

    #[test]
    fn clip_inputs_and_their_bytes() {
        let m = two_stretches("clip-inputs");
        assert_eq!(
            video_inputs(m.path(), 5_000, 10_000).unwrap(),
            vec![paths::video_file(1), paths::video_file(2)]
        );
        assert_eq!(
            video_inputs(m.path(), 7_500, 8_500).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            video_inputs(m.path(), 20_000, 21_000).unwrap(),
            vec![paths::video_file(2)]
        );
        // Capped at five minutes from the start.
        assert_eq!(
            video_inputs(m.path(), 0, 1_000_000).unwrap(),
            vec![paths::video_file(1), paths::video_file(2)]
        );
        let bytes = clip_input_bytes(m.path(), 5_000, 10_000).unwrap();
        let cut = cut_clips(m.path(), 5_000, 10_000, soon()).unwrap();
        assert_eq!(bytes, cut.clips.iter().map(|c| c.bytes).sum::<u64>());
        assert_eq!(clip_input_bytes(m.path(), 7_500, 8_500).unwrap(), 0);
        assert_eq!(
            video_inputs(TestDir::new("clip-inputs-none").path(), 0, 1).unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn sweep_deletes_clips_unused_for_an_hour() {
        let root = TestDir::new("sweep");
        let m = root.path().join("m-20261030-171203-4f2a");
        let clips = paths::clips_dir(&m);
        std::fs::create_dir_all(&clips).unwrap();
        let now = SystemTime::now();
        let make = |name: &str, age_s: u64| {
            let path = clips.join(name);
            std::fs::write(&path, b"x").unwrap();
            File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(now - Duration::from_secs(age_s))
                .unwrap();
            path
        };
        let old = make("c-000000000-000001000-000001.mp4", 3_700);
        let fresh = make("c-000001000-000002000-000001.mp4", 600);
        let stale_tmp = make("c-000002000-000003000-000001.mp4.tmp", 4_000);
        let other = make("notes.txt", 9_000);
        let busy = make("c-000003000-000004000-000001.mp4", 9_000);
        let guard = lock_path(&busy);
        let deleted = sweep_clips(root.path(), wall_ms(now), 3_600_000);
        assert_eq!(deleted, 2);
        assert!(!old.exists() && !stale_tmp.exists());
        assert!(fresh.exists() && other.exists() && busy.exists());
        drop(guard);
        assert_eq!(sweep_clips(root.path(), wall_ms(now), 3_600_000), 1);
        assert_eq!(sweep_clips(&root.path().join("missing"), 0, 0), 0);
        // touch_clip keeps one another hour.
        let kept = make("c-000005000-000006000-000001.mp4", 9_000);
        touch_clip(&kept).unwrap();
        assert_eq!(
            sweep_clips(root.path(), wall_ms(SystemTime::now()), 3_600_000),
            0
        );
    }

    #[test]
    fn closed_files_follow_the_journal() {
        let m = meeting("closed", "video");
        write_video(m.path(), 1, 2);
        write_video(m.path(), 2, 2);
        write_frame(m.path(), 1_000, b"jpg");
        write_frame(m.path(), 2_000, b"jpg");
        // A JPEG on disk that no frame line names yet, a clip, temp files and screen.json.
        write_frame(m.path(), 3_000, b"jpg");
        std::fs::write(
            paths::resolve(m.path(), "screen/frames/f-000004000.jpg.tmp").unwrap(),
            b"x",
        )
        .unwrap();
        std::fs::create_dir_all(paths::clips_dir(m.path())).unwrap();
        std::fs::write(paths::clip_path(m.path(), 0, 1, 1), b"x").unwrap();
        std::fs::write(paths::screen_file_path(m.path()), b"{}").unwrap();
        let mut lines = vec![
            video(0, 1),
            frame(1_000, "a"),
            video_end(1_500, 1),
            video(1_600, 2),
            frame(2_000, "b"),
            // A frame whose JPEG retention removed, and one naming a file outside frames/.
            frame(2_500, "gone"),
            Line::Frame {
                t: 2_600,
                id: "f-000002600".into(),
                file: "screen/screen.json".into(),
                width: 1,
                height: 1,
                text: String::new(),
                ocr: "none".into(),
                language: None,
            },
        ];
        journal(m.path(), &lines);
        let frame_of = |t| {
            (
                paths::frame_file(&paths::frame_id(t)),
                ScreenFileKind::Frame,
            )
        };
        assert_eq!(
            closed_files(m.path()).unwrap(),
            vec![
                (paths::video_file(1), ScreenFileKind::Video),
                frame_of(1_000),
                frame_of(2_000),
            ]
        );
        lines = vec![
            video_end(3_000, 2),
            Line::Stop {
                t: 3_000,
                reason: "meeting".into(),
            },
        ];
        journal(m.path(), &lines);
        assert_eq!(
            closed_files(m.path()).unwrap(),
            vec![
                (paths::video_file(1), ScreenFileKind::Video),
                frame_of(1_000),
                (paths::video_file(2), ScreenFileKind::Video),
                frame_of(2_000),
                ("screen/journal.jsonl".to_string(), ScreenFileKind::Journal),
            ]
        );
        assert_eq!(
            closed_files(TestDir::new("closed-none").path()).unwrap(),
            vec![]
        );
    }
}
